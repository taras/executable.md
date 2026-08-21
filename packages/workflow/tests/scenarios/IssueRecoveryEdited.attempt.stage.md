# One issue, filed and then edited by somebody else

<StagedRun id="run-296-issue" />
<Attempt as="attempt" />

<Interrupted when={attempt.number === 1} />

<GitHubServer as="server" />

Between the attempts somebody rewrites the title on the tracker. It still
carries this key's marker, and it is still open in the repository the request
named — so it is this request's issue, saying something this request did not
ask it to say.

<RetitleIssue number={1} to="Somebody rewrote this" when={attempt.number === 2} />

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
