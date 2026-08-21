# Reading an issue

A self-closing `<Issue>` with a `url` reads the issue that URL names. The URL is
the identity, so nothing else is needed and nothing else is consulted — a
tracker written around a read has nothing to add to it.

Every scenario declares the tracker it runs against, the provider that handles
it, that provider's authorized ceiling, and the credential the transport
carries. None of those is defaulted out of sight, because each of them is a
consequential fact about what the scenario proves.

## What a read binds

<Test name="A read binds the fields every provider has">
<FreshTracker />
<GitHubServer as="server" />
<RemoteIssue
  number={1}
  title="Retry the publish step"
  body="The publish step failed twice in a row on 503."
  tags={["reliability", "publish"]}
  assignee="octocat"
/>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url}>
<Issue url={server.repository + "/issues/1"} as="issue" />
</GitHubIssues>
<AssertEquals
  actual={issue}
  expected={{
    url: server.repository + "/issues/1",
    title: "Retry the publish step",
    description: "The publish step failed twice in a row on 503.",
    tags: ["publish", "reliability"],
    assignee: "octocat"
  }}
/>
</Test>

A closed issue reads exactly like an open one. Reading is not reconciling, and
refusing to report a closed issue would invent a state the document did not ask
about.

<Test name="A closed issue reads as itself">
<FreshTracker />
<GitHubServer as="server" />
<RemoteIssue number={1} title="Already done" body="It was fixed elsewhere." state="closed" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url}>
<Issue url={server.repository + "/issues/1"} as="issue" />
</GitHubIssues>
<AssertEquals actual={issue.title} expected="Already done" />
<AssertEquals actual={issue.tags} expected={[]} />
<AssertEquals actual={issue.assignee} expected={null} />
</Test>

## It renders nothing and needs no tracker

<Test name="A read renders exactly nothing">
<FreshTracker />
<GitHubServer as="server" />
<RemoteIssue number={1} title="Quiet" body="…" />
<Capture as="rendered">
<GitHubIssues ceiling={[server.repository]} endpoint={server.url}>
<Issue url={server.repository + "/issues/1"} as="issue" />
</GitHubIssues>
</Capture>
<AssertEquals actual={rendered} expected="" />
</Test>

<Test name="A read outside any tracker still reads">
<FreshTracker />
<GitHubServer as="server" />
<RemoteIssue number={1} title="No tracker needed" body="…" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url}>
<Issue url={server.repository + "/issues/1"} as="issue" />
</GitHubIssues>
<AssertEquals actual={issue.title} expected="No tracker needed" />
</Test>

## The exact request it makes

<Test name="A read is one authenticated GET of that issue">
<FreshTracker />
<GitHubServer as="server" />
<RemoteIssue number={7} title="Seven" body="…" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url}>
<Issue url={server.repository + "/issues/7"} as="issue" />
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={["GET"]} />
<AssertEquals actual={sent.paths} expected={["/repos/octo/project/issues/7"]} />
<AssertEquals actual={sent.authorizations} expected={["Bearer"]} />
<AssertEquals actual={sent.credentialed} expected={true} />
</Test>

GitHub answers for a pull request through the same Issues endpoint. Reporting
one as an issue would let a document read a pull request's body as an issue
description, so it is refused.

<Test name="A pull request returned by the Issues endpoint is refused">
<FreshTracker />
<GitHubServer as="server" />
<RemoteIssue number={3} title="A pull request" body="…" pullRequest={true} />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url}>
<AssertThrows message="conflicts with">
<PrintErrors>
<Issue url={server.repository + "/issues/3"} as="issue" />
</PrintErrors>
</AssertThrows>
</GitHubIssues>
</Test>

## The ceiling is asked before the transport

<Test name="A read outside the ceiling sends nothing">
<FreshTracker />
<GitHubServer as="server" />
<GitHubIssues ceiling={["https://github.com/octo/authorized"]} endpoint={server.url}>
<AssertThrows message="temporarily unavailable">
<PrintErrors>
<Issue url="https://github.com/octo/secrets/issues/1" as="issue" />
</PrintErrors>
</AssertThrows>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={[]} />
</Test>
