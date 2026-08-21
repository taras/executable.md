# Which provider answers

There is no router. A provider is ordinary `IssueApi` middleware: it looks at
the request, and either it recognizes it or it passes it on unchanged. Nothing
central decides; the answer comes from whichever installed middleware claims the
request first.

Every scenario below declares both providers at once — a GitHub-shaped one over
a loopback tracker, and an Atlassian-shaped one — so that "handled it" and "was
never asked" are both observable. The logs are declared with them.

## Each provider takes its own, and passes on the rest

<Test name="A GitHub URL reaches GitHub, and Atlassian is never asked">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<RemoteIssue number={1} title="A GitHub issue" body="…" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<Issue url={server.repository + "/issues/1"} as="issue" />
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={issue.title} expected="A GitHub issue" />
<AssertEquals actual={sent.methods} expected={["GET"]} />
<AssertEquals actual={atlassian.reads} expected={0} />
</Test>

The same two providers, the other URL. The GitHub provider does not recognize it
and hands it on untouched, so the tracker it speaks for receives nothing.

<Test name="An Atlassian URL reaches Atlassian, and the GitHub tracker receives nothing">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<Issue url="https://acme.atlassian.net/browse/PROJ-1" as="issue" />
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={issue.title} expected="An Atlassian issue" />
<AssertEquals actual={atlassian.reads} expected={1} />
<AssertEquals actual={sent.methods} expected={[]} />
</Test>

Filing works the same way. The tracker names the container, and the provider that
recognizes it is the one that files.

<Test name="An upsert goes to the provider that recognizes its tracker">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url="https://acme.atlassian.net/browse">
<Issue title="Filed elsewhere" as="issue">Into an Atlassian-shaped tracker.</Issue>
</IssueTracker>
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={atlassian.upserts} expected={1} />
<AssertEquals actual={sent.methods} expected={[]} />
<AssertEquals actual={issue.url} expected="https://acme.atlassian.net/browse/PROJ-1" />
</Test>

## A named provider is asked about URLs it would not recognize

A self-hosted deployment has GitHub's path shape under another host name.
Recognition is `github.com` and nothing else, so a document that wants such a URL
handled says which provider handles it.

<Test name="An explicit discriminator routes a URL no provider recognizes">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<RemoteIssue number={1} title="Self-hosted" body="…" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues
  ceiling={["https://git.acme.test/octo/project"]}
  endpoint={server.url}
  credential="valid"
>
<Issue url="https://git.acme.test/octo/project/issues/1" provider="github" as="issue" />
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={issue.title} expected="Self-hosted" />
<AssertEquals actual={sent.paths} expected={["/repos/octo/project/issues/1"]} />
<AssertEquals actual={atlassian.reads} expected={0} />
</Test>

## A provider that took the request owns the answer

Naming a provider sends the request there and leaves it there. The URL below is
one the GitHub provider recognizes, and it is never asked: the named provider
took it and refused, and a refusal is an answer.

<Test name="A named provider's refusal is final, and the recognizing provider is never asked">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<AssertThrows message="temporarily unavailable">
<PrintErrors>
<Issue url={server.repository + "/issues/1"} provider="atlassian" as="issue" />
</PrintErrors>
</AssertThrows>
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={atlassian.reads} expected={1} />
<AssertEquals actual={sent.methods} expected={[]} />
</Test>

An upsert names its provider in the tracker, which is the place that owns the
deployment choice. Named there, the same self-hosted URL is filed by the same
provider that would not have recognized it.

<Test name="A tracker's discriminator routes an upsert no provider recognizes">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues
  ceiling={["https://git.acme.test/octo/project"]}
  endpoint={server.url}
  credential="valid"
>
<IssueTracker url="https://git.acme.test/octo/project" provider="github">
<Issue title="Filed self-hosted" as="issue">Into a tracker no host name gives away.</Issue>
</IssueTracker>
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={sent.methods} expected={["GET", "POST"]} />
<AssertEquals actual={sent.titles} expected={["", "Filed self-hosted"]} />
<AssertEquals actual={atlassian.upserts} expected={0} />
</Test>

Filing is the same about finality. The tracker below is one the GitHub provider
recognizes, and it is never asked: the named provider took the request and
refused.

<Test name="A named provider's refusal is final for an upsert too">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository} provider="atlassian">
<AssertThrows message="temporarily unavailable">
<PrintErrors>
<Issue title="Refused" as="issue">Sent to a provider that will not have it.</Issue>
</PrintErrors>
</AssertThrows>
</IssueTracker>
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={atlassian.upserts} expected={1} />
<AssertEquals actual={sent.methods} expected={[]} />
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.count} expected={0} />
</Test>

## When nobody claims it

With no provider recognizing the URL, the request reaches the base of the chain
unchanged, and the base says so. It is the same refusal whether nothing is
installed or nothing matched — there is nowhere else for the request to have
gone.

<Test name="A URL no provider recognizes reaches the base refusal">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<AssertThrows message="no issue provider handles">
<PrintErrors>
<Issue url="https://bugs.example.test/tickets/1" as="issue" />
</PrintErrors>
</AssertThrows>
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={sent.methods} expected={[]} />
<AssertEquals actual={atlassian.reads} expected={0} />
</Test>

A discriminator nobody answers to says something different, because the document
did name somebody.

<Test name="A discriminator no provider answers to reaches the base refusal too">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<AssertThrows message="no issue provider is installed under gitlab">
<PrintErrors>
<Issue url={server.repository + "/issues/1"} provider="gitlab" as="issue" />
</PrintErrors>
</AssertThrows>
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={sent.methods} expected={[]} />
<AssertEquals actual={atlassian.reads} expected={0} />
</Test>

An upsert reaches the same two base refusals, worded for what it was trying to
do rather than for a read.

<Test name="A tracker no provider recognizes reaches the base refusal">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url="https://bugs.example.test/project">
<AssertThrows message="no issue provider handles">
<PrintErrors>
<Issue title="Nowhere to file this" as="issue">Nobody claims this tracker.</Issue>
</PrintErrors>
</AssertThrows>
</IssueTracker>
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={sent.methods} expected={[]} />
<AssertEquals actual={atlassian.upserts} expected={0} />
</Test>

<Test name="A tracker discriminator no provider answers to reaches the base refusal">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository} provider="gitlab">
<AssertThrows message="no issue provider is installed under gitlab">
<PrintErrors>
<Issue title="Nobody by that name" as="issue">Named a provider nobody answers to.</Issue>
</PrintErrors>
</AssertThrows>
</IssueTracker>
</GitHubIssues>
</AtlassianIssues>
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={sent.methods} expected={[]} />
<AssertEquals actual={atlassian.upserts} expected={0} />
</Test>

## A nearer surface answers for its own subtree, and nothing else

<Test name="A nearer override answers inside its content, delegates other URLs, and ends at its close">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<RemoteIssue number={1} title="From the tracker" body="…" />
<RemoteIssue number={2} title="Also from the tracker" body="…" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueApiOverride
  handles={server.repository + "/issues/1"}
  answers="https://example.test/issues/999"
>
<Issue url={server.repository + "/issues/1"} as="overridden" />
<Issue url={server.repository + "/issues/2"} as="delegated" />
</IssueApiOverride>
<Issue url={server.repository + "/issues/1"} as="after" />
</GitHubIssues>
<ProviderLog as="providers" />
<ServerRequests as="sent" />
<AssertEquals actual={overridden.url} expected="https://example.test/issues/999" />
<AssertEquals actual={delegated.title} expected="Also from the tracker" />
<AssertEquals actual={after.title} expected="From the tracker" />
<AssertEquals actual={providers.overrides} expected={1} />
<AssertEquals actual={sent.paths} expected={[
  "/repos/octo/project/issues/2",
  "/repos/octo/project/issues/1"
]} />
</Test>

An override applies to filing the same way. It answers the tracker it claims,
hands on the one it does not, and stops at its close.

<Test name="A nearer override handles its upsert, delegates another, and ends at its close">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueApiOverride
  handles="https://acme.atlassian.net/browse"
  answers="https://example.test/issues/999"
>
<IssueTracker url="https://acme.atlassian.net/browse">
<Issue title="Overridden" as="overridden">Answered by the nearer surface.</Issue>
</IssueTracker>
<IssueTracker url={server.repository}>
<Issue title="Delegated" as="delegated">Handed on to the provider that recognizes it.</Issue>
</IssueTracker>
</IssueApiOverride>
<IssueTracker url="https://acme.atlassian.net/browse">
<Issue title="After" as="after">Filed once the override has closed.</Issue>
</IssueTracker>
</GitHubIssues>
</AtlassianIssues>
<ProviderLog as="providers" />
<ServerRequests as="sent" />
<AtlassianTracker as="atlassian" />
<AssertEquals actual={overridden.url} expected="https://example.test/issues/999" />
<AssertEquals actual={delegated.url} expected={server.repository + "/issues/1"} />
<AssertEquals actual={after.url} expected="https://acme.atlassian.net/browse/PROJ-1" />
<AssertEquals actual={providers.overrides} expected={1} />
<AssertEquals actual={atlassian.upserts} expected={1} />
<AssertEquals actual={sent.methods} expected={["GET", "POST"]} />
</Test>

## A nested tracker replaces the outer one, and only for its content

A tracker is not merged into the one around it. Inside, the inner tracker is the
whole answer; after it closes, the outer one is again.

<Test name="A nested tracker replaces the outer one, and leaving it restores the outer">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<AtlassianIssues ceiling={["https://acme.atlassian.net/browse"]}>
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<IssueTracker url="https://acme.atlassian.net/browse">
<Issue title="Inside" as="inner">Filed against the inner tracker.</Issue>
</IssueTracker>
<Issue title="Outside" as="outer">Filed against the outer tracker again.</Issue>
</IssueTracker>
</GitHubIssues>
</AtlassianIssues>
<AtlassianTracker as="atlassian" />
<TrackerIssues as="tracker" />
<AssertEquals actual={atlassian.upserts} expected={1} />
<AssertEquals actual={inner.url} expected="https://acme.atlassian.net/browse/PROJ-1" />
<AssertEquals actual={tracker.count} expected={1} />
<AssertEquals actual={tracker.titles} expected={["Outside"]} />
</Test>

## The ceiling is a provider's own question, asked before it connects

A provider that recognizes a request still decides whether it is authorized to
act on it, and it decides before it opens a connection.

<Test name="A matched provider outside its ceiling sends nothing">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<EmptyAtlassianTracker />
<GitHubServer as="server" />
<GitHubIssues
  ceiling={["https://github.com/octo/authorized"]}
  endpoint={server.url}
  credential="valid"
>
<AssertThrows message="temporarily unavailable">
<PrintErrors>
<Issue url="https://github.com/octo/secrets/issues/1" as="issue" />
</PrintErrors>
</AssertThrows>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={[]} />
</Test>

A provider that recognizes a tracker asks the same question before it files
anything into it.

<Test name="A matched upsert outside its ceiling sends nothing">
<EmptyTracker />
<EmptyRequestLog />
<EmptyProviderLog />
<GitHubServer as="server" />
<GitHubIssues
  ceiling={["https://github.com/octo/authorized"]}
  endpoint={server.url}
  credential="valid"
>
<IssueTracker url="https://github.com/octo/secrets">
<AssertThrows message="temporarily unavailable">
<PrintErrors>
<Issue title="Outside the ceiling" as="issue">Nothing should leave this document.</Issue>
</PrintErrors>
</AssertThrows>
</IssueTracker>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={[]} />
</Test>
