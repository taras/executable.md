<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url}>
<Issue url={server.repository + "/issues/1"} as="issue" />
</GitHubIssues>

read {issue.title}
