---
description: >-
  Run the authorized checks on an exact signed correction. Use
  <ExactCorrection.Verify repository={repository} approval={approval}
  revision={revision} as="receipt" />. A different change returns to review;
  a failed check holds the ticket.
props:
  type: object
  properties:
    repository: {type: string, pattern: '^/'}
    approval: {type: object}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [repository, approval, revision]
  additionalProperties: false
returns: {type: object}
---
<Let as="approval" value={props.approval} />
<ExactCorrection.Schema as="schema" />
<Parse schema={schema} as="offer"><Json value={approval.offer} /></Parse>
<Let as="checks" value={[]} />
<Dir path={props.repository}>
```bash exec as="source"
git show -s --format='%H %T %P' {props.revision}
```
<If condition={source.exitCode !== 0 || source.stdout.trim() !== props.revision + " " + offer.targetTree + " " + offer.baseRevision}>
<Return value={{status:"review_required",reason:"The correction differs from the exact authorized tree or single-parent base.",approval,revision:props.revision,source,checks}} />
<Else>
<ExactCorrection.Patch repository={props.repository} offer={offer} as="patch" />
<Ticket.Checkout repository={props.repository} as="before" />
<Dir path={props.repository}>
```bash exec as="untracked"
git status --porcelain=v1 --untracked-files=all
```
</Dir>
<If condition={untracked.exitCode !== 0 || untracked.stdout.length !== 0}><Fail message="Exact correction requires a checkout without untracked or modified files." /></If>
<If condition={!before.clean || before.head !== props.revision}><Fail message="Exact checks require the actual clean correction HEAD." /></If>
<Ticket.Signature repository={props.repository} revision={props.revision} as="signature" />
<If condition={signature.exitCode !== 0}><Fail message="Exact correction signature verification failed." /></If>
<Let as="index" value={0} />
<Loop max={offer.checks.length}>
<Let as="check" value={offer.checks[index]} />
<If condition={checks.every(receipt => receipt.exitCode === 0)}>
<Let as="command" value={check.argv.map(arg => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(" ")} />
```bash exec as="execution"
{command}
```
<Let as="checks" value={[...checks,{name:check.name,argv:check.argv,revision:props.revision,...execution}]} />
</If>
<Let as="index" value={index + 1} />
</Loop>
<If condition={checks.some(check => check.exitCode !== 0)}>
<Return value={{status:"failed",reason:"An authorized check failed; preserve this first result and do not repeat it automatically.",approval,revision:props.revision,source,patch,before,signature,checks}} />
<Else>
<Ticket.Checkout repository={props.repository} as="after" />
```bash exec as="afterStatus"
git status --porcelain=v1 --untracked-files=all
```
<If condition={afterStatus.exitCode !== 0 || afterStatus.stdout.length !== 0 || !after.clean || after.head !== props.revision}><Fail message="An authorized check changed tracked source or HEAD." /></If>
<Return value={{status:"verified",approval,revision:props.revision,source,patch,before,signature,checks,after}} />
</Else>
</If>
</Else>
</If>
</Dir>
