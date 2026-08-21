# One issue, filed and then duplicated

<StagedRun id="run-296-issue" />
<Attempt as="attempt" />

<Interrupted when={attempt.number === 1} />

<GitHubServer as="server" />

Between the attempts a second issue turns up carrying the first one's body, and
so the first one's marker. The copy is made by the fixture rather than written
here, because a marker is a digest of a key and a document that could write one
would be writing a run's internal identity into its own text.

<DuplicateIssue number={1} when={attempt.number === 2} />

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
