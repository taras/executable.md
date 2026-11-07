# One hosted observation is needed

Recipient: coordinator (ROOT). Resume the same retained Planner after this receipt exists.

Use an already prepared, isolated ubuntu-latest x86_64 checkout at `bd85a00406f245adffda5b296d4dc8163347cacd`, Bun `1.4.0 (34cbb9a40)` and Deno `2.9.5`. Preparation, if needed, remains `deno task setup`. Preserve the original failure, source/API/response allowances and all guards. No role/model changes, productive retries, merge, release, test-weight maintenance or proposed source correction are requested.

Copy the three text kit files `hosted-capture.py`, `progress-plugin.mjs` and `bin/deno` together beneath a private artifact directory. Do not install them in the checkout. Run the following once, substituting actual absolute paths:

```text
python3 /phase/kit/hosted-capture.py --source /prepared/source --output /phase/hosted-first --bun /absolute/bun --deno /absolute/deno
```

The output must be a fresh directory under this phase's artifact directory on that host. The driver verifies clean source and exact runtime versions, adds a private PATH shim for the Deno CLI descendants, and invokes the existing Bun test once with its existing 300000 ms runtime cap. It changes no fixture source, test timeout, scenario or assertion and injects no delay. It neither dispatches roles nor invokes paid models itself; the existing fixture uses fake roles. Both streams are retained in `first-output.log`. It waits for the exact child and saves its exit code in `hosted-command-receipt.json`. There is no automatic repeat.

Retain every text file in that output, including `progress.jsonl`, `children.jsonl`, generated observer/shim and command receipt. Return a text index of them. A successful run is an observation, never a repair or proof of the historical cause. If the original inner timeout occurs, identify the fixture Test and scenario ordinal, most recent completed operation, currently unmatched exec-start, and Deno child wait result. Compare those positions with the exact committed fixture to distinguish accumulated progressing work from a particular stalled operation. Diagnostic `*-cleanup` events are observer finalizers only; `child-waited` is exact-child wait(), not independent proof about every descendant or output pump. The observer adds unmeasured I/O overhead. Do not infer a cause from duration alone.

This driver is a prepared diagnostic artifact, not a tested hosted command. Its Python syntax was checked locally; the same observer/shim performed the saved macOS capture. No claim of Linux execution or cancellation-survival validation is made.
