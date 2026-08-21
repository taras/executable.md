# Reading an issue

A self-closing `<Issue>` with a `url` reads the issue that URL names. The URL is
the identity, so nothing else is needed and nothing else is consulted — a
tracker written around a read has nothing to add to it.

Every scenario declares the tracker it runs against, the provider that handles
it, that provider's authorized ceiling, and which credential the transport
carries. None of those is defaulted out of sight, because each of them is a
consequential fact about what the scenario proves.

The credential is declared by name — `credential="valid"` — and never by value.
The token itself stays with the host: a document holding one would be refused by
this repository's secret gate before it could run, and a document that rendered
one would not settle at all.

This document is about what a read *is* and what it binds. What a read sends —
method, path, authorization, body — is `IssueHttp.test.md`, and which provider
answers it is `IssueRouting.test.md`.

## What a read binds

<Test name="A read binds the fields every provider has">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<RemoteIssue
  number={1}
  title="Retry the publish step"
  body="The publish step failed twice in a row on 503."
  tags={["reliability", "publish"]}
  assignee="octocat"
/>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
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
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<RemoteIssue number={1} title="Already done" body="It was fixed elsewhere." state="closed" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<Issue url={server.repository + "/issues/1"} as="issue" />
</GitHubIssues>
<AssertEquals actual={issue.title} expected="Already done" />
<AssertEquals actual={issue.tags} expected={[]} />
<AssertEquals actual={issue.assignee} expected={null} />
</Test>

## It renders nothing and needs no tracker

<Test name="A read renders exactly nothing">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<RemoteIssue number={1} title="Quiet" body="…" />
<Capture as="rendered">
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<Issue url={server.repository + "/issues/1"} as="issue" />
</GitHubIssues>
</Capture>
<AssertEquals actual={rendered} expected="" />
</Test>

<Test name="A read outside any tracker still reads">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<RemoteIssue number={1} title="No tracker needed" body="…" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<Issue url={server.repository + "/issues/1"} as="issue" />
</GitHubIssues>
<AssertEquals actual={issue.title} expected="No tracker needed" />
</Test>

GitHub answers for a pull request through the same Issues endpoint. Reporting
one as an issue would let a document read a pull request's body as an issue
description, so it is refused.

<Test name="A pull request returned by the Issues endpoint is refused">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<RemoteIssue number={3} title="A pull request" body="…" pullRequest={true} />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<AssertThrows message="conflicts with">
<PrintErrors>
<Issue url={server.repository + "/issues/3"} as="issue" />
</PrintErrors>
</AssertThrows>
</GitHubIssues>
</Test>
