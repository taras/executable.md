---
inputs:
  number:
    type: number
    required: false
---

```ts eval
const token = process.env.GITHUB_TOKEN;
const api = "https://api.github.com/repos/taras/executable-markdown-agents";
const headers = {
  "Accept": "application/vnd.github+json",
};
if (token) {
  headers["Authorization"] = "Bearer " + token;
}

let result;

if (number && number > 0) {
  const resp = yield* fetch(api + "/issues/" + number, { headers }).expect().json();
  result = {
    number: resp.number,
    title: resp.title,
    state: resp.state,
    body: resp.body,
    labels: resp.labels.map(l => l.name),
    url: resp.html_url,
  };
} else {
  const resp = yield* fetch(
    api + "/issues?labels=ema-cleanup&state=open&per_page=10",
    { headers },
  ).expect().json();
  result = resp.map(issue => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body,
    labels: issue.labels.map(l => l.name),
    url: issue.html_url,
  }));
}

return '```json\n' + JSON.stringify(result, null, 2) + '\n```';
```
