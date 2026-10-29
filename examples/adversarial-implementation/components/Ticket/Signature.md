---
description: >-
  Verify an existing commit's signature. Use <Ticket.Signature
  repository={repository} revision={feedbackSha} as="verification" />.
props:
  type: object
  properties:
    repository: {type: string, pattern: '^/'}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [repository, revision]
  additionalProperties: false
returns: {type: object}
---

Use the repository's configured verifier and return the complete exit status,
stdout and stderr. Settlement saves the receipt before deciding whether the
signature satisfies its gate.

Replace this shell block with the supported commit-read verification form of
`Git.Commit` after [#974](https://github.com/taras/executable.md/issues/974) is
implemented. The calling document continues to own acceptance policy.

<Dir path={props.repository}>
```bash exec as="verification"
git verify-commit {props.revision}
```
<Return value={verification} />
</Dir>
