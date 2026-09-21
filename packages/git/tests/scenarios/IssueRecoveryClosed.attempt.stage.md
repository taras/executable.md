# One issue, filed and then closed

<StagedRun id="run-296-issue" />
<Attempt as="attempt" />

<Interrupted when={attempt.number === 1} />

<GitHubServer as="server" />

Between the attempts somebody closes it. It still carries this key's marker.

<CloseIssue number={1} when={attempt.number === 2} />

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
