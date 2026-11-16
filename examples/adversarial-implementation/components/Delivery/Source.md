---
description: 'Observe the current local branch, commit and worktree. Use <Delivery.Source repository={repository} as="source" />.'
props:
  type: object
  properties:
    repository: {type: string, pattern: '^/'}
    trackHead: {type: boolean, default: false}
  required: [repository]
  additionalProperties: false
returns: {type: object}
---

<Dir path={props.repository}>
```bash exec as="worktree"
git --no-optional-locks status --porcelain=v2 --branch --untracked-files=normal --ignore-submodules=none
```
</Dir>
<If condition={worktree.exitCode !== 0}><Fail message="Could not read the delivery checkout." /></If>
<Let as="lines" value={worktree.stdout.trimEnd().split("\n")} />
<Let as="headPrefix" value="# branch.oid " />
<Let as="branchPrefix" value="# branch.head " />
<Parse schema={{type:"string",pattern:"^[0-9a-f]{40}$"}} as="head"><Json value={lines.find(line => line.startsWith(headPrefix))?.slice(headPrefix.length) ?? null} /></Parse>
<Let as="branch" value={lines.find(line => line.startsWith(branchPrefix))?.slice(branchPrefix.length) ?? null} />
<If condition={branch === "(detached)"}>
<Dir path={props.repository}>
```bash exec as="symbolic"
git symbolic-ref --quiet --short HEAD
```
</Dir>
<Let as="branch" value={symbolic.exitCode === 0 ? symbolic.stdout.trim() : null} />
</If>
<Let as="source" value={{head,branch,clean:lines.every(line => line.startsWith("#"))}} />
<If condition={props.trackHead}>
<Dir path={props.repository}>
```bash exec as="history"
set -e -o pipefail
git reflog exists HEAD
git reflog show --no-color --no-notes --no-show-signature --format='%H %gD %gs' --date=raw HEAD | git hash-object --stdin
```
</Dir>
<Let as="digest" value={history.stdout.trim()} />
<Let as="source" value={{...source,headHistory:history.exitCode === 0 && /^[0-9a-f]{40}$/.test(digest) ? digest : null}} />
</If>
<Return value={source} />
