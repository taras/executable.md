# One read, staged twice

Both attempts of this run are this document, for the reason every staged pair
here is: a request's identity includes the expansion it was made at.

<StagedRun id="run-296-issue" />
<Attempt as="attempt" />

<GitHubServer as="server" />
<RemoteIssue
  number={1}
  title="Retry the publish step"
  body="The publish step failed twice in a row on 503."
  tags={["publish", "reliability"]}
  assignee="octocat"
/>

On the second attempt the provider boundary refuses everything. A replay that
answered from the retained result does not notice; one that asked would fail
here rather than quietly making a second request.

<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<NoIssueProvider when={attempt.number === 2}>
<Issue url={server.repository + "/issues/1"} as="issue" />
</NoIssueProvider>
</GitHubIssues>

read {issue.title} / {issue.assignee} / {issue.tags}
