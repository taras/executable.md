# One issue, filed and then unreachable

<StagedRun id="run-296-issue" />
<Attempt as="attempt" />

The first attempt's process ends after the tracker accepted the issue and before
it could journal anything about it. The document stops there, which is what a
process ending means: nothing below this point runs on that attempt.

<Interrupted when={attempt.number === 1} />

<GitHubServer as="server" />

On the retry the transport will not answer at all, so this request's state stays
unknown to it.

<GitHubIssues
  ceiling={[server.repository]}
  endpoint={server.url}
  credential="valid"
  interruptsAfterCreate={attempt.number === 1}
  failsTransport={attempt.number === 2}
>
<IssueTracker url={server.repository}>
<Issue title="Retry the publish step" as="issue">
The publish step failed twice in a row on 503.
</Issue>
</IssueTracker>
</GitHubIssues>

filed {issue.url}
