---
description: >-
  Collect every changed path between two commits. Use <Ticket.ChangedPaths
  repository={repository} base={accepted} head={feedback} as="changes" />.
props:
  type: object
  properties:
    repository: {type: string, pattern: '^/'}
    base: {type: string, pattern: '^[0-9a-f]{40}$'}
    head: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [repository, base, head]
  additionalProperties: false
returns: {type: object}
---

Review assignments carry the complete path list. Follow each returned cursor
before returning; retain the pages beside the list so the comparison is inspectable.

<Dir path={props.repository}>
<Let as="cursor" value={null} />
<Let as="paths" value={[]} />
<Let as="pages" value={[]} />
<Loop max={Number.MAX_SAFE_INTEGER}>
<If condition={cursor === null}>
<Git.Changes compare="commits" base={props.base} head={props.head} limit={100} as="page" />
</If>
<If condition={cursor !== null}>
<Git.Changes compare="commits" base={props.base} head={props.head} limit={100} cursor={cursor} as="page" />
</If>
<Let as="paths" value={[...paths,...page.changes.map(change => change.path)]} />
<Let as="pages" value={[...pages,page]} />
<If condition={page.next === null}><Break /></If>
<Let as="cursor" value={page.next.cursor} />
</Loop>
<If condition={page.next !== null}><Fail message="The changed-path listing did not finish." /></If>
<Return value={{paths,pages}} />
</Dir>
