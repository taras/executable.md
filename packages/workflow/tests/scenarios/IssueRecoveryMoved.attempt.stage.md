# One issue, filed and then somewhere else

<StagedRun id="run-296-issue" />
<Attempt as="attempt" />

<Interrupted when={attempt.number === 1} />

<GitHubServer as="server" />

Between the attempts the issue turns up in another repository, still carrying
this key's marker.

<MoveIssue number={1} to="https://api.github.com/repos/octo/moved" when={attempt.number === 2} />

<GitHubIssues
  ceiling={[server.repository]}
  endpoint={server.url}
  credential="valid"
  interruptsAfterCreate={attempt.number === 1}
>
<IssueTracker url={server.repository}>
<Issue title="Retry the publish step" as="issue">
The publish step failed twice in a row on 503.
</Issue>
</IssueTracker>
</GitHubIssues>

filed {issue.url}
