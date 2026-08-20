# Issue

`<Issue>` files one issue in the tracker the nearest lexical context names. It
takes four props and nothing else, renders nothing, and binds one value: the
URL of the issue it settled on.

Every scenario below arranges the fixture first with `<IssueFixture />`, which
is this suite's own component rather than part of the contract — it resets the
tracker each scenario stands on, so what a scenario asserts is what that
scenario caused.

## What it produces

The whole of the public result is the URL. There is no issue number, no
provider name, no provider-owned identity and no reconciliation detail, because
a document that could branch on any of those would stop being portable across
providers — which is the one thing this primitive is for.

<Test name="A settled issue binds exactly a url, and renders nothing">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project">
<Issue title="Retry the publish step" description="It failed twice on 503." as="issue" />
</IssueTracker>
<AssertEquals actual={issue} expected={{ url: "https://github.com/owner/repository/issues/1" }} />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.creates} expected={1} />
</Test>

The element renders nothing at all, so the text around it is the whole of what
a reader of the run sees.

<Test name="The element contributes nothing to the rendering">
<IssueFixture />
<Capture as="rendered">
<IssueTracker url="https://github.com/octo/project">
before
<Issue title="Retry the publish step" description="It failed twice on 503." as="issue" />
after
</IssueTracker>
</Capture>
<AssertStringIncludes actual={rendered} expected="before" />
<AssertStringIncludes actual={rendered} expected="after" />
<AssertNotMatch actual={rendered} expected={/Retry the publish step/} />
<AssertNotMatch actual={rendered} expected={/It failed twice on 503/} />
</Test>

## What it refuses

A prop this primitive does not declare is refused rather than ignored, because
a prop that is silently dropped is a document asking for something it will not
get and never being told.

<Test name="An undeclared prop is refused">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project">
<AssertThrows message="Prop validation failed">
<PrintErrors>
<Issue title="T" description="D" milestone="1.4" as="issue" />
</PrintErrors>
</AssertThrows>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.requests} expected={0} />
</Test>

The element takes no content. Content written around one would be discarded in
silence, and an issue filed beside text nobody ever saw is worse than one not
filed at all — so a paired invocation is refused on the shape of the invocation,
before the tracker is read and before the boundary is reached.

<Test name="A paired invocation is refused, with content">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project">
<AssertThrows message="takes no content">
<PrintErrors>
<Issue title="T" description="D" as="issue">
text nobody would ever see
</Issue>
</PrintErrors>
</AssertThrows>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.requests} expected={0} />
</Test>

<Test name="A paired invocation is refused, empty">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project">
<AssertThrows message="takes no content">
<PrintErrors>
<Issue title="T" description="D" as="issue"></Issue>
</PrintErrors>
</AssertThrows>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.requests} expected={0} />
</Test>

## What it requires before it asks for anything

A missing tracker, and a URL that is not the plain credential-free name of a
container, are the document's own mistakes. Each is decided before the boundary
is reached, so nothing is sent while a document is wrong about where it is
writing.

<Test name="An Issue outside any tracker fails before the boundary">
<IssueFixture />
<AssertThrows message="no destination">
<PrintErrors>
<Issue title="T" description="D" as="issue" />
</PrintErrors>
</AssertThrows>
<IssueState as="state" />
<AssertEquals actual={state.requests} expected={0} />
</Test>

A URL carrying userinfo is refused rather than stripped, because stripping it
would send the request somewhere the document did not write. The `user:password`
spelling is deliberately not written here: this repository's own secret gate
reads a document before it is journaled, and a literal of that shape is refused
before any scenario could run — which is the gate working, not a gap.

<Test name="A URL carrying userinfo is refused rather than stripped">
<IssueFixture />
<IssueTracker url="https://token@github.com/octo/project">
<AssertThrows message="no destination">
<PrintErrors>
<Issue title="T" description="D" as="issue" />
</PrintErrors>
</AssertThrows>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.requests} expected={0} />
</Test>

<Test name="A discriminator that is not a provider name is refused">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project" provider="GitHub">
<AssertThrows message="lower-case name">
<PrintErrors>
<Issue title="T" description="D" as="issue" />
</PrintErrors>
</AssertThrows>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.requests} expected={0} />
</Test>

## Tags and assignee

Tags are a set. Order is not what makes an issue that issue, so a document that
writes the same tags in another order is asking the same question — and what
reaches the tracker is deduplicated and sorted by code point.

<Test name="Duplicate unordered tags arrive as a sorted set">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project">
<Issue
  title="Retry the publish step"
  description="It failed twice on 503."
  tags={["reliability", "publish", "reliability"]}
  as="issue"
/>
</IssueTracker>
<IssueState as="state" />
<AssertEquals actual={state.labels} expected={[["publish", "reliability"]]} />
</Test>

An omitted assignee has one spelling everywhere, and an authored one is carried
opaquely: no provider translates it through another directory.

<Test name="An omitted assignee is one absence, and an authored one is opaque">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project">
<Issue title="First" description="D" as="unassigned" />
</IssueTracker>
<IssueState as="empty" />
<AssertEquals actual={empty.assignees} expected={[null]} />

<IssueFixture />
<IssueTracker url="https://github.com/octo/project">
<Issue title="Second" description="D" assignee="octocat" as="assigned" />
</IssueTracker>
<IssueState as="named" />
<AssertEquals actual={named.assignees} expected={["octocat"]} />
</Test>

## Nesting

A nested tracker replaces the whole value for its descendants, and the outer one
is what the siblings after it use again. Members are never merged: a child that
kept its parent's provider while replacing its URL would ask one service about
another's container.

<Test name="A nested tracker replaces the whole value and then restores it">
<IssueFixture />
<IssueTracker url="https://github.com/octo/project">
<IssueTracker url="https://acme.atlassian.net/browse/PROJ">
<Issue title="Inner" description="D" as="inner" />
</IssueTracker>
<Issue title="Outer" description="D" as="outer" />
</IssueTracker>
<AssertStringIncludes actual={inner.url} expected="acme.atlassian.net" />
<AssertStringIncludes actual={outer.url} expected="github.com" />
<IssueState as="state" />
<AssertEquals actual={state.issues} expected={1} />
<AssertEquals actual={state.atlassian} expected={1} />
</Test>
