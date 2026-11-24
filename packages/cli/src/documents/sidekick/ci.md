# CI

Read this when you need to wait for pull request checks or verify a specific
workflow attempt after merge.

## Applies to

Sidekick responses and the REPL entries they submit.

## Instructions

- Read `<Guide.Entries />` first. Use the task's canonical pull request URL and
  choose a time budget. Put the entire wait in one ordinary entry.
- `<PullRequest.Checks url=… watch timeoutSeconds={…} as="checkResult" />`
  watches every reported check run and commit status for the head it first
  observes, and binds `{ outcome, reason?, headSha, checks }`. It waits for
  every reported check to settle, even after one has failed.
- Successful, skipped and neutral results pass. Failure, error, cancellation,
  timeout and action-required results fail. A pull request that reports no
  checks yet keeps the watch waiting.
- Submit the entry, read the receipt, and then read that exact entry's output,
  for example with `<REPL.Entry.Output entry={2} />` when the receipt names
  entry 2. Read further pages as needed. A completed entry can report any CI
  outcome; use the watch result from that entry for the next action.
- Decide from `outcome`, never from a filtered array: a list of failed records
  can be empty while CI is still pending.
  - `success`: report that the watched checks passed for `headSha`.
  - `failure`: inspect the failed records and their links. The query shows
    failed rows across the full collection.
  - `incomplete` with `reason: "timeout"`: report what was still pending and
    decide whether to wait again.
  - `incomplete` with `reason: "head-changed"`: report the watched `headSha`
    and confirm the intended revision before starting another watch.
  - `incomplete` with `reason: "read-error"`: report that the outcome could not
    be established.
- While the entry runs, the person can read its **Output · live** for the short
  head and the passed, failed and pending counts. Draft **Stop** ends the watch
  and binds nothing. Sidekick **Stop** ends the Send and leaves an admitted
  entry running; read that exact entry when you resume.
- Keep compact derived values in root bindings and put large reports or
  separately collected progress histories in files.

## Example

This response submits an entry that renders the result and uses `Query` to show
failed rows only once the outcome is known to be `failure`.

`````xmd
<Let as="code" select="code">
````xmd
<PullRequest.Checks url="https://github.com/taras/executable.md/pull/123"
  watch timeoutSeconds={600} as="checkResult" />

<Output>
<Json value={checkResult} />

<If condition={checkResult.outcome === "failure"}>
### Failed check records

<Query value={checkResult.checks}
  yq='[.[] | select((.kind == "check-run" and .status == "completed" and (.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out" or .conclusion == "action_required")) or (.kind == "commit-status" and (.state == "failure" or .state == "error")))]' />
</If>
</Output>
````
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
`````

If the 600-second budget expires while a check is pending, the entry renders:

```json
{
  "outcome": "incomplete",
  "reason": "timeout",
  "headSha": "0123456789abcdef0123456789abcdef01234567",
  "checks": [
    {
      "kind": "commit-status",
      "id": "42",
      "headSha": "0123456789abcdef0123456789abcdef01234567",
      "name": "green",
      "state": "pending",
      "description": "CI is running",
      "url": "https://github.com/taras/executable.md/actions/runs/45030887260",
      "createdAt": "2026-11-23T12:00:00Z",
      "updatedAt": "2026-11-23T12:00:00Z"
    }
  ]
}
```

## Verify a workflow attempt after merge

`<PullRequest.Checks>` watches a pull request's head, not a workflow run. For a
specific attempt after merge, use `gh` with the repository, workflow, intended
merge SHA, run ID and attempt number. Identify the run by workflow and merge
SHA, then inspect the requested attempt:

```sh
gh run view 45030887260 --repo taras/executable.md --attempt 1
gh api repos/taras/executable.md/actions/runs/45030887260/attempts/1 --jq '{runId: .id, attempt: .run_attempt, headSha: .head_sha, status, conclusion}'
```

Replace the example identifiers with the task's own. Compare the returned head
SHA with the intended merge SHA before reporting the result. If the attempt is
still active, repeat the same attempt-scoped read within the task's time budget.
Use `status` and `conclusion` to report how that attempt ended. A retry has a
different attempt number; keep the original attempt in the command when the
task asks about its outcome.

## Common mistake

Treating an empty failed-records query as success. Query only selects from the
records the watch returned; it says nothing about whether the watch settled.
Branch on `outcome` first.

## Read next

`<Guide.Lifetimes />` for cancellation and `<Guide.Bindings />` for published
values.
