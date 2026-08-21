# One read of an issue the tracker will not answer about

<StagedRun id="run-296-issue" />
<Attempt as="attempt" />

<GitHubServer as="server" />

Issue 1 is the one this document asks for. Issue 99 is somewhere else entirely,
and the tracker is told to answer for 1 with 99 — a well-formed payload about
the wrong issue, on every attempt.

<RemoteIssue number={1} title="The one that was asked for" body="…" />
<RemoteIssue
  number={99}
  title="A different issue entirely"
  body="Somewhere else."
  repository="https://api.github.com/repos/other/elsewhere"
/>
<AnswerInstead asked={1} with={99} />

<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<Issue url={server.repository + "/issues/1"} as="issue" />
</GitHubIssues>

read {issue.title}
