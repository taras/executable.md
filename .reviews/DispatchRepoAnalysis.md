---
title: Dispatch Repo Analysis Workflow
---

<GitHubAuth>
```ts eval
import { sleep } from "effection";
import { ensureDir, glob, readTextFile } from "@executablemd/runtime";
import { env as runtimeEnv, exec, fetch as runtimeFetch } from "@executablemd/runtime";

function repositoryFromRemote(remote) {
  const match = remote.trim().match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? "";
}

function* request(url, options = {}) {
  const response = yield* runtimeFetch(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
    },
  });
  const body = yield* response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GitHub workflow request failed (${response.status})`);
  }
  return body ? JSON.parse(body) : {};
}

function* dispatch() {
  const requestedRef = (yield* runtimeEnv("ANALYZE_REF")) ?? "";
  const reportPrefix = (yield* runtimeEnv("ANALYZE_REPORT_NAME")) ?? "repo-analysis";
  const token = yield* runtimeEnv("GITHUB_TOKEN");

  const branchResult = yield* exec({ command: ["git", "rev-parse", "--abbrev-ref", "HEAD"] });
  if (branchResult.exitCode !== 0) {
    throw new Error(branchResult.stderr || "Unable to resolve the current branch");
  }
  const remoteResult = yield* exec({ command: ["git", "remote", "get-url", "origin"] });
  if (remoteResult.exitCode !== 0) {
    throw new Error(remoteResult.stderr || "Unable to resolve the origin remote");
  }

  const repo = (yield* runtimeEnv("GITHUB_REPOSITORY")) ?? repositoryFromRemote(remoteResult.stdout);
  const targetRef = requestedRef || branchResult.stdout.trim();
  const dispatchStart = new Date().toISOString();
  yield* request(`https://api.github.com/repos/${repo}/actions/workflows/repo-analysis.yml/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: targetRef, inputs: { ref: targetRef, report_name: reportPrefix } }),
  });

  let run;
  for (let attempt = 0; attempt < 30 && !run; attempt++) {
    const response = yield* request(
      `https://api.github.com/repos/${repo}/actions/runs?event=workflow_dispatch&branch=${encodeURIComponent(targetRef)}&per_page=20`,
    );
    run = response.workflow_runs?.find((candidate) => candidate.created_at >= dispatchStart);
    if (!run) {
      yield* sleep(2_000);
    }
  }
  if (!run) {
    throw new Error("Unable to locate the dispatched workflow run");
  }

  for (;;) {
    run = yield* request(`https://api.github.com/repos/${repo}/actions/runs/${run.id}`);
    if (run.status === "completed") {
      break;
    }
    yield* sleep(2_000);
  }
  if (run.conclusion !== "success") {
    throw new Error(`Repository analysis concluded ${run.conclusion}`);
  }

  const artifactDir = `.reviews/artifacts/${run.id}`;
  yield* ensureDir(artifactDir);
  const download = yield* exec({
    command: ["gh", "run", "download", String(run.id), "--repo", repo, "--dir", artifactDir],
    env: { GH_TOKEN: token },
  });
  if (download.exitCode !== 0) {
    throw new Error(download.stderr || "Unable to download the analysis artifact");
  }

  const files = yield* glob({ root: artifactDir, patterns: ["**/*.md", "**/*.json"] });
  const reportEntry = files.find((entry) => entry.isFile && entry.path.endsWith("analyze-report.md"));
  const metadataEntry = files.find((entry) => entry.isFile && entry.path.endsWith("analyze-run.json"));
  return {
    repo,
    targetRef,
    reportPrefix,
    run,
    reportText: reportEntry ? yield* readTextFile(reportEntry.path) : "(report artifact not found)",
    metadataText: metadataEntry ? yield* readTextFile(metadataEntry.path) : "{}",
  };
}

const result = yield* dispatch();
```

</GitHubAuth>

## Repo Analysis Dispatch

- Repository: `{result.repo}`
- Ref: `{result.targetRef}`
- Run ID: `{result.run.id}`
- Run URL: {result.run.html_url}
- Status: `{result.run.status}`
- Conclusion: `{result.run.conclusion}`

### Run Metadata

```json
{result.metadataText}
```

### Report

{result.reportText}
