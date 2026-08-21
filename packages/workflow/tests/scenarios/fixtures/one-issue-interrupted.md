<GitHubServer as="server" />
<GitHubIssues
  ceiling={[server.repository]}
  endpoint={server.url}
 
  interruptsAfterCreate={true}
>
<IssueTracker url={server.repository}>
<Issue title="Retry the publish step" as="issue">
The publish step failed twice in a row on 503.
</Issue>
</IssueTracker>
</GitHubIssues>

filed {issue.url}
