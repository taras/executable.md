---
title: Fetch Cleanup Issues
---

```ts eval
const issueNumber = process.env.ISSUE_NUMBER
  ? parseInt(process.env.ISSUE_NUMBER, 10)
  : 0;
```

<FetchIssues number={issueNumber} />
