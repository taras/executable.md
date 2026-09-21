# Filing an issue

A paired `<Issue>` with a `title` files the issue its content describes. The
enclosing `<IssueTracker>` says which container it goes in; the element says what
it says. What comes back is a reference — a URL and nothing else — because that
is the whole of what filing an issue tells the document that asked.

## What an upsert binds

<Test name="An upsert binds a reference, and only a reference">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<Issue title="Retry the publish step" as="issue">
The publish step failed twice in a row on 503.
</Issue>
</IssueTracker>
</GitHubIssues>
<AssertEquals actual={issue} expected={{ url: server.repository + "/issues/1" }} />
</Test>

The content is the description, and it is rendered before it is sent — a
document files what it wrote, not the source it wrote it in. Filing takes two
requests: the tracker is read before anything is created, so the create is
never the first thing that happens.

<Test name="The content becomes the description">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<Issue title="Rendered" as="issue">
The publish step failed **twice** in a row.
</Issue>
</IssueTracker>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={["GET", "POST"]} />
<AssertEquals
  actual={sent.descriptions}
  expected={["", "\nThe publish step failed **twice** in a row.\n"]}
/>
</Test>

## Tags are a set, however they are written

Order is not identity. Two documents that disagree about how to spell one set of
tags are asking the same question, and the tracker is told the same thing.

<Test name="Two authored orders reach the tracker as one set">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<Issue title="Tagged" tags={["reliability", "publish", "reliability"]} as="issue">
Written one way.
</Issue>
</IssueTracker>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.labels} expected={[[], ["publish", "reliability"]]} />
</Test>

## What it refuses, and when

Every refusal below is decided by the element itself, before anything is routed
and before any provider is asked. Each test states that twice: the refusal
happened, and the boundary was never reached.

<Test name="An element that is both a read and an upsert is neither">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<AssertThrows message="cannot do both at once">
<PrintErrors>
<Issue url={server.repository + "/issues/1"} title="Both" as="issue">
Neither of these.
</Issue>
</PrintErrors>
</AssertThrows>
</IssueTracker>
</GitHubIssues>
<ServerRequests as="sent" />
<ProviderLog as="providers" />
<AssertEquals actual={sent.methods} expected={[]} />
<AssertEquals actual={providers.keys} expected={[]} />
</Test>

<Test name="A read with content is refused before it reads">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<AssertThrows message="takes no content">
<PrintErrors>
<Issue url={server.repository + "/issues/1"} as="issue">
Content a read has no use for.
</Issue>
</PrintErrors>
</AssertThrows>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={[]} />
</Test>

<Test name="An upsert with no content is refused before it files">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<AssertThrows message="it needs content">
<PrintErrors>
<Issue title="Empty" as="issue" />
</PrintErrors>
</AssertThrows>
</IssueTracker>
</GitHubIssues>
<ServerRequests as="sent" />
<ProviderLog as="providers" />
<AssertEquals actual={sent.methods} expected={[]} />
<AssertEquals actual={providers.keys} expected={[]} />
</Test>

An upsert takes its provider from the tracker, which is where a deployment's
choice belongs. Saying it twice would be two places to keep in agreement.

<Test name="An upsert cannot name its own provider">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<AssertThrows message="provider does not apply here">
<PrintErrors>
<Issue title="Pinned" provider="github" as="issue">
A provider named in the wrong place.
</Issue>
</PrintErrors>
</AssertThrows>
</IssueTracker>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={[]} />
</Test>

<Test name="An element that is neither form says so">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<AssertThrows message="This is neither">
<PrintErrors>
<Issue as="issue" />
</PrintErrors>
</AssertThrows>
</IssueTracker>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={[]} />
</Test>
