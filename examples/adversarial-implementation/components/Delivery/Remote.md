---
description: 'Read current PR and CI evidence. Use <Delivery.Remote repository="owner/repo" number={123} as="remote" />.'
props:
  type: object
  properties:
    repository: {type: string, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'}
    number: {type: integer, minimum: 1}
  required: [repository, number]
  additionalProperties: false
returns: {type: object}
---

<Let as="sha" value={{type:"string",pattern:"^[0-9a-f]{40}$"}} />
<Let as="reference" value={{type:"object",properties:{sha,ref:{type:"string",minLength:1}},required:["sha","ref"]}} />
<Let as="prSchema" value={{type:"object",properties:{head:reference,base:{type:"object",properties:{ref:{type:"string",minLength:1}},required:["ref"]},state:{enum:["open","closed"]},draft:{type:"boolean"},merged:{type:"boolean"},merge_commit_sha:{anyOf:[sha,{type:"null"}]},labels:{type:"array",items:{type:"object",properties:{name:{type:"string"}},required:["name"]}}},required:["head","base","state","draft","merged","merge_commit_sha","labels"]}} />
<Let as="mainSchema" value={{type:"object",properties:{commit:{type:"object",properties:{sha},required:["sha"]}},required:["commit"]}} />
<Let as="pagesSchema" value={{type:"array",items:{type:"object",properties:{workflow_runs:{type:"array",items:{type:"object"}}},required:["workflow_runs"]}}} />

```bash exec as="prRead"
gh api repos/{props.repository}/pulls/{props.number}
```
<If condition={prRead.exitCode !== 0}><Fail message={"Read the current PR before reporting readiness. " + prRead.stderr} /></If>
<Parse schema={prSchema} as="pr">{prRead.stdout}</Parse>
<Let as="revision" value={pr.head.sha} />
<Parse schema={{type:"string",pattern:"^[0-9a-f]{40}$"}} as="revision"><Json value={revision} /></Parse>
```bash exec as="prRunsRead"
gh api --paginate --slurp 'repos/{props.repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={revision}&per_page=100'
```
```bash exec as="mainRead"
gh api repos/{props.repository}/branches/main
```
<If condition={prRunsRead.exitCode !== 0 || mainRead.exitCode !== 0}><Fail message="CI or main could not be read. Preserve the first command failure; unavailable evidence is not a pass." /></If>
<Parse schema={pagesSchema} as="prPages">{prRunsRead.stdout}</Parse>
<Parse schema={mainSchema} as="main">{mainRead.stdout}</Parse>
<Parse schema={{type:"string",pattern:"^[0-9a-f]{40}$"}} as="mainRevision"><Json value={main.commit.sha} /></Parse>
```bash exec as="mainRunsRead"
gh api --paginate --slurp 'repos/{props.repository}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha={mainRevision}&per_page=100'
```
<If condition={mainRunsRead.exitCode !== 0}><Fail message="Main CI could not be read. Unavailable evidence is not a pass." /></If>
<Parse schema={pagesSchema} as="mainPages">{mainRunsRead.stdout}</Parse>
<Delivery.SelectRuns revision={revision} mainRevision={mainRevision} prPages={prPages} mainPages={mainPages} as="runs" />
<Let as="ciGreen" value={false} />
<If condition={runs.ci !== null}>
```bash exec as="jobsRead"
gh api --paginate --slurp repos/{props.repository}/actions/runs/{runs.ci.id}/attempts/{runs.ci.attempt}/jobs
```
<If condition={jobsRead.exitCode !== 0}><Fail message="Read the required green job on the selected CI attempt before reporting readiness." /></If>
<Parse schema={{type:"array",items:{type:"object",properties:{jobs:{type:"array",items:{type:"object",properties:{name:{type:"string"},status:{type:"string"},conclusion:{type:["string","null"]}},required:["name","status","conclusion"]}}},required:["jobs"]}}} as="jobPages">{jobsRead.stdout}</Parse>
<Let as="greenJobs" value={jobPages.flatMap(page => page.jobs).filter(job => job.name === "green")} />
<Let as="ciGreen" value={greenJobs.length === 1 && greenJobs[0].status === "completed" && greenJobs[0].conclusion === "success"} />
</If>
```bash exec as="mainAgainRead"
gh api repos/{props.repository}/branches/main
```
```bash exec as="prAgainRead"
gh api repos/{props.repository}/pulls/{props.number}
```
<If condition={mainAgainRead.exitCode !== 0 || prAgainRead.exitCode !== 0}><Fail message="Current-head CI readback failed. Refresh the evidence before reporting readiness." /></If>
<Parse schema={mainSchema} as="mainAgain">{mainAgainRead.stdout}</Parse>
<Parse schema={prSchema} as="prAgain">{prAgainRead.stdout}</Parse>
<Return value={{revision,branch:pr.head.ref,base:pr.base.ref,draft:prAgain.draft,state:prAgain.state,merged:prAgain.merged,mergeRevision:prAgain.merge_commit_sha,stable:prAgain.head.sha === revision && prAgain.head.ref === pr.head.ref && prAgain.base.ref === pr.base.ref && mainAgain.commit.sha === mainRevision,ci:runs.ci,ciGreen,main:{revision:mainRevision,run:runs.main},mainRepair:prAgain.labels.some(label => label.name === "ci-main-red-fix")}} />
