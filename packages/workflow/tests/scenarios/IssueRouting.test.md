# Issue routing

A provider is ordinary middleware around one operation. There is no registry to
be listed in, no resolver to consult and no protocol to speak: an adapter looks
at the destination it was handed and either handles it or passes it along.

Two providers are installed for every scenario below — the shipped GitHub
middleware, and an Atlassian-shaped one this suite supplies so that "the request
went to the right service" is a claim about two real handlers rather than about
one handler and a mock.

## Matching by URL

With no discriminator, each provider recognizes its own URLs. One document can
therefore write to both without saying which is which.

<Test name="Each provider handles only the URLs it recognizes">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project">
<Issue title="On GitHub" description="D" as="onGitHub" />
</IssueTracker>
<IssueTracker url="https://acme.atlassian.net/browse/PROJ">
<Issue title="On Atlassian" description="D" as="onAtlassian" />
</IssueTracker>
<AssertStringIncludes actual={onGitHub.url} expected="github.com" />
<AssertStringIncludes actual={onAtlassian.url} expected="acme.atlassian.net" />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.atlassian} expected={1} />
<AssertEquals actual={state.titles} expected={["On GitHub"]} />
<AssertEquals actual={state.atlassianRequests} expected={1} />
</Test>

## Matching by discriminator

A tracker that names a provider names the only one allowed to act, whatever the
URL looks like. That is what makes a self-hosted deployment addressable: the
provider that would otherwise never recognize the host is asked outright, and
the one that matches by URL delegates it.

<Test name="An explicit discriminator carries a URL no provider would recognize">
<IssueFixture />
<IssueTracker url="https://git.example.invalid/octo/project" provider="github">
<Issue title="Self hosted" description="D" as="issue" />
</IssueTracker>
<AssertExists actual={issue.url} />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.titles} expected={["Self hosted"]} />
<AssertEquals actual={state.atlassianRequests} expected={0} />
</Test>

## A refusal after matching is the end

Once middleware matches, it owns the answer. It does not delegate afterwards,
and nothing catches its refusal to try somebody else — because a search is how a
document that named one service quietly reaches another.

The discriminating case is a URL the *other* provider would have taken. An
explicit discriminator selects a provider that refuses, and the provider that
matches the URL is never asked — which is what "no fallback" means when it costs
something.

<Test name="An explicitly named provider's refusal is not somebody else's opportunity">
<IssueFixture atlassianRefuses={true} />
<IssueTracker url="https://github.com/octo/project" provider="atlassian">
<AssertThrows message="temporarily unavailable">
<PrintErrors>
<Issue title="Refused" description="D" as="issue" />
</PrintErrors>
</AssertThrows>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.atlassianRequests} expected={1} />
<AssertEquals actual={state.issues} expected={0} />
<AssertEquals actual={state.requests} expected={0} />
</Test>

<Test name="The matched provider's refusal reaches the document untouched">
<IssueFixture atlassianRefuses={true} />
<IssueTracker url="https://acme.atlassian.net/browse/PROJ">
<AssertThrows message="temporarily unavailable">
<PrintErrors>
<Issue title="Refused" description="D" as="issue" />
</PrintErrors>
</AssertThrows>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.atlassianRequests} expected={1} />
<AssertEquals actual={state.issues} expected={0} />
<AssertEquals actual={state.requests} expected={0} />
</Test>

## When nobody matches

A destination no installed provider recognizes reaches the operation's own base
error, unchanged. It names the URL and the discriminator, because those are the
document's own words and the thing an author has to fix.

<Test name="An unrecognized URL reports the base error and mutates nothing">
<IssueFixture />
<IssueTracker url="https://tracker.example.invalid/projects/one">
<AssertThrows message="no issue provider handles">
<PrintErrors>
<Issue title="Nowhere" description="D" as="issue" />
</PrintErrors>
</AssertThrows>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={0} />
<AssertEquals actual={state.atlassian} expected={0} />
<AssertEquals actual={state.requests} expected={0} />
</Test>

<Test name="An unknown discriminator reports the base error and mutates nothing">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project" provider="gitlab">
<AssertThrows message="no issue provider is installed under gitlab">
<PrintErrors>
<Issue title="Nowhere" description="D" as="issue" />
</PrintErrors>
</AssertThrows>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={0} />
<AssertEquals actual={state.requests} expected={0} />
</Test>

## The ceiling is the host's, not the tracker's

A tracker is composition data: a document can write any URL and reach nothing it
was not already allowed to reach. What decides is the ceiling the provider holds
beside its credentials, and it is checked before the transport is touched.

<Test name="A target outside the ceiling is refused before anything is sent">
<IssueFixture ceiling={["https://github.com/octo/project"]} />
<IssueTracker url="https://github.com/other/secrets">
<AssertThrows message="temporarily unavailable">
<PrintErrors>
<Issue title="Elsewhere" description="D" as="issue" />
</PrintErrors>
</AssertThrows>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.requests} expected={0} />
<AssertEquals actual={state.issues} expected={0} />
</Test>

A tracker may narrow within the ceiling, which is what a container beneath an
authorized one is.

<Test name="A container beneath an authorized one is admitted">
<IssueFixture ceiling={["https://github.com/octo/project"]} />
<IssueTracker url="https://github.com/octo/project/issues">
<Issue title="Beneath" description="D" as="issue" />
</IssueTracker>
<AssertExists actual={issue.url} />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
</Test>

## A nearer surface is lexical

`IssueApi` is an ordinary contextual operation, so middleware installed nearer
answers for its own content and for nothing else. That is how one subtree is
redirected without changing what its siblings do, and it is the same mechanism
providers themselves use.

<Test name="A nearer override answers its own content and no sibling">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project">
<IssueOverride url="https://example.test/issues/99">
<Issue title="Overridden" description="D" as="inner" />
</IssueOverride>
<Issue title="Ordinary" description="D" as="outer" />
</IssueTracker>
<AssertEquals actual={inner} expected={{ url: "https://example.test/issues/99" }} />
<AssertStringIncludes actual={outer.url} expected="github.com" />
<IssueState as="state" />
<AssertEquals actual={state.overrides} expected={1} />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.titles} expected={["Ordinary"]} />
</Test>
