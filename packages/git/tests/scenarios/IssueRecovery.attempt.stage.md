# One attempt of the recovery scenario, staged twice

Both attempts of this run are this document. They have to be: a request's
identity includes the expansion it was made at, so two attempts written as two
documents would never ask the same question, and the second could not recognize
what the first left on the tracker.

What differs between them is therefore stated here, in terms of which attempt is
running.

<StagedRun id="run-296-issue" />
<Attempt as="attempt" />

The first attempt's process ends after the tracker has accepted its issue and
before it can journal anything about it. Declared before the work, because an
attempt that fails never reaches the bottom of its own document.

<Interrupted when={attempt.number === 1} />

<GitHubServer as="server" />
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
