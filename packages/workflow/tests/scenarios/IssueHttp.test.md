# What goes over the wire

Every scenario here runs the shipped transport — `denoGitHubAccess`, the same
function the Deno CLI installs — against a real HTTP server listening on
loopback. Nothing about `fetch` is stubbed: the requests asserted below are
requests a server received, parsed, and answered.

The credential is the one thing supplied host-side, because a document holding
one would be refused by this repository's secret gate before it could run. It is
named here — `credential="valid"` — and what the server made of it is reported
back as an answer.

## Filing an issue: read the tracker, then create

<Test name="A create is a GET of the issue collection and then a POST to it">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<Issue title="Retry the publish step" tags={["publish"]} assignee="octocat" as="issue">
The publish step failed twice in a row on 503.
</Issue>
</IssueTracker>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={["GET", "POST"]} />
<AssertEquals
  actual={sent.paths}
  expected={["/repos/octo/project/issues", "/repos/octo/project/issues"]}
/>
</Test>

Both requests carried the credential the tracker requires. The header is checked
where its value is already known and reported as an answer, so the token appears
neither in this document nor in anything the run retained.

<Test name="Both requests carried a Bearer credential the tracker accepted">
<ServerRequests as="sent" />
<AssertEquals actual={sent.schemes} expected={["Bearer", "Bearer"]} />
<AssertEquals actual={sent.credentialed} expected={true} />
</Test>

The created issue's JSON body is exactly the four members GitHub is asked for,
and no others.

<Test name="The create body is title, body, labels and assignees">
<ServerRequests as="sent" />
<AssertEquals
  actual={sent.bodyKeys}
  expected={[[], ["assignees", "body", "labels", "title"]]}
/>
<AssertEquals actual={sent.titles} expected={["", "Retry the publish step"]} />
<AssertEquals actual={sent.labels} expected={[[], ["publish"]]} />
<AssertEquals actual={sent.assignees} expected={["", "octocat"]} />
</Test>

The body carries the origin marker, which is what lets an interrupted attempt be
recognized by the next one. It is reported as a count rather than as text: it is
a digest of the run's idempotency key, and a document that received it would
hold a run's internal identity in its own rendered output.

<Test name="The create body carries an origin marker, and the read has no body at all">
<ServerRequests as="sent" />
<AssertEquals actual={sent.markers} expected={1} />
<AssertEquals actual={sent.bodyKeys[0]} expected={[]} />
</Test>

## A second element is a second issue

Two `<Issue>` elements are at two positions, so they are two requests with two
keys and two markers. The second does not update the first, however alike they
look — an update belongs to a request that already exists, and this is a
different one.

<Test name="A second element at another position files a second issue">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<IssueTracker url={server.repository}>
<Issue title="Same wording" as="first">
Before.
</Issue>
<Issue title="Same wording" as="second">
After.
</Issue>
</IssueTracker>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={["GET", "POST", "GET", "POST"]} />
<AssertEquals actual={sent.markers} expected={2} />
<TrackerIssues as="tracker" />
<AssertEquals actual={tracker.count} expected={2} />
<AssertNotEquals actual={first.url} expected={second.url} />
</Test>

## Reading an issue: one GET of that issue

<Test name="A read is a single authenticated GET of the issue named">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<RemoteIssue number={7} title="Seven" body="…" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="valid">
<Issue url={server.repository + "/issues/7"} as="issue" />
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={["GET"]} />
<AssertEquals actual={sent.paths} expected={["/repos/octo/project/issues/7"]} />
<AssertEquals actual={sent.schemes} expected={["Bearer"]} />
<AssertEquals actual={sent.credentialed} expected={true} />
<AssertEquals actual={sent.bodyKeys} expected={[[]]} />
</Test>

## A credential the tracker does not accept

Named the same way, and the answer is the tracker's rather than this fixture's:
the server rejects it, and the request's state becomes unknown rather than
absent.

<Test name="A rejected credential is unavailable, not absence">
<EmptyTracker />
<EmptyRequestLog />
<GitHubServer as="server" />
<RemoteIssue number={7} title="Seven" body="…" />
<GitHubIssues ceiling={[server.repository]} endpoint={server.url} credential="invalid">
<AssertThrows message="temporarily unavailable">
<PrintErrors>
<Issue url={server.repository + "/issues/7"} as="issue" />
</PrintErrors>
</AssertThrows>
</GitHubIssues>
<ServerRequests as="sent" />
<AssertEquals actual={sent.methods} expected={["GET"]} />
<AssertEquals actual={sent.schemes} expected={["Bearer"]} />
<AssertEquals actual={sent.credentialed} expected={false} />
</Test>
