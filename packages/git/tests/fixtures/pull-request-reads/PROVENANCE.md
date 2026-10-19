# Legacy Workflow read histories

Captured from pristine `2f975b01acd33c1085612bf7da3fc848adb571c3` *before* the
shared-read amendment, because the third history is one the corrected worker
deliberately refuses and therefore cannot be produced again. Never regenerate
these files: a changed name, payload or source position must show up as a
failure here rather than be absorbed by a new capture.

Each file holds the document that produced it and the replayable journal prefix
— every event the run appended except the root's own close, which is what an
unfinished history has.

| File | SHA-256 of the file | What it is |
| --- | --- | --- |
| `legacy-valid-success.json` | `8d6377772a94584e7dbf1ec378c80b321a5392a0e65688a3df7d8545db2d2696` | one completed `<PullRequest.Reviews>` read, proven to restore on the old worker with no further request |
| `legacy-saved-error.json` | `76e53571a10a897ff4b2010e0a30168eefba472d4d68e1a134be25114f30874a` | one expected read failure saved as this read's own (`status: "err"`), proven to restore on the old worker with no further request |
| `legacy-inconsistent-checks.json` | `3ba5a6f70b450532ff81c89896b98250034835ecb08c80ef617e0743872bf6f9` | one `<PullRequest.Checks>` success whose item names another commit, which the old kind-only validation appended without noticing |

Capture command, run from the implementation worktree against the unedited tree:

    deno test --allow-all --frozen --config deno.json \
      <scratchpad>/capture-legacy-reads.test.ts

The capture used the real Workflow profile — `gitPluginAdmissions()` plus
`retainedWorkflowInstallation` through `runWorkflowDocument` — and the suite's
own GitHub payload shapes. The third history's envelope was handed to the
retained seam by a handler in front of the adapter, because the provider itself
refuses a check naming another commit: the inconsistent envelope is what
middleware above a provider could always have saved.
