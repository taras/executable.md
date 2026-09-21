# An attempt that filed an issue and journaled that it had

The first attempt of the durability scenario. Nothing goes wrong here: the
tracker accepts the create, the answer gets back, and the result is retained
under this run.

<StagedRun id="run-296-issue" />

<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<Issue title="Retry the publish step" as="issue">
The publish step failed twice in a row on 503.
</Issue>
</IssueTracker>
</GitHubIssues>

filed {issue.url}
