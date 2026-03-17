---
title: Dispatch Repo Analysis Workflow
---

```ts eval
const requestedRef = process.env.ANALYZE_REF ?? "";
const reportPrefix = process.env.ANALYZE_REPORT_NAME ?? "repo-analysis";
```

<Capture as="currentBranch">

```bash exec
git rev-parse --abbrev-ref HEAD
```

</Capture>

<Capture as="repoName">

```bash exec
gh repo view --json nameWithOwner -q .nameWithOwner
```

</Capture>

<Capture as="dispatchStart">

```bash exec
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

</Capture>

```ts eval
const targetRef = requestedRef || currentBranch.trim();
const repo = repoName.trim();
const dispatchStartIso = dispatchStart.trim();
```

```bash exec
gh workflow run repo-analysis.yml --repo {repo} --ref {targetRef} -f ref={targetRef} -f report_name={reportPrefix}
```

<Capture as="runId">

```bash exec
for i in $(seq 1 30); do
  RUN_ID=$(gh run list --repo {repo} --workflow repo-analysis.yml --event workflow_dispatch --json databaseId,headBranch,createdAt -q 'map(select(.headBranch == "{targetRef}" and .createdAt >= "{dispatchStartIso}")) | .[0].databaseId // ""')
  if [ -n "$RUN_ID" ]; then
    printf '%s' "$RUN_ID"
    exit 0
  fi
  sleep 2
done
echo ""
```

</Capture>

```ts eval
const runIdValue = runId.trim();
```

```bash exec
if [ -z "{runIdValue}" ]; then
  echo "Unable to locate workflow run id" >&2
  exit 1
fi
gh run watch {runIdValue} --repo {repo} --exit-status
```

<Capture as="runJson">

```bash exec
gh run view {runIdValue} --repo {repo} --json databaseId,url,status,conclusion,headSha,displayTitle,createdAt,updatedAt
```

</Capture>

```bash silent exec
mkdir -p .reviews/artifacts/{runIdValue}
gh run download {runIdValue} --repo {repo} --dir .reviews/artifacts/{runIdValue}
```

```ts eval
const run = JSON.parse(runJson);
const artifactDir = `.reviews/artifacts/${runIdValue}`;
const reportPath = `${artifactDir}/${reportPrefix}-${run.headSha}/analyze-report.md`;
const metadataPath = `${artifactDir}/${reportPrefix}-${run.headSha}/analyze-run.json`;
const runUrl = run.url ?? "";
const runStatus = run.status ?? "";
const runConclusion = run.conclusion ?? "";

let reportText = "";
let metadataText = "";

try {
  reportText = Deno.readTextFileSync(reportPath);
} catch {
  reportText = "(analyze-report.md artifact not found)";
}

try {
  metadataText = Deno.readTextFileSync(metadataPath);
} catch {
  metadataText = "{}";
}
```

## Repo Analysis Dispatch

- Repository: `{repo}`
- Ref: `{targetRef}`
- Run ID: `{runIdValue}`
- Run URL: {runUrl}
- Status: `{runStatus}`
- Conclusion: `{runConclusion}`

### Run Metadata

```json
{metadataText}
```

### Report

{reportText}
