<Section title="Resource Lifetime">

A TypeScript component acquires resources with ordinary Effection
operations, and the invocation boundary releases them when it finishes.
That is the right lifetime for a wrapper — whatever it set up is exactly
as long-lived as the content it wraps.

A component that hands something back needs the opposite. `<Probe />`
allocates a token and returns it, and the caller is going to use that
token *after* the invocation is over. Releasing it at the boundary would
hand back a name for something that no longer exists, so `<Probe />`
asks for the token with `retain()`: the resource is created in the scope
that invoked the component and lives as long as that scope does.

Which form is running is `hasContent()`'s answer, taken from how the
element was written rather than from what it renders. `<Probe>text</Probe>`
and `<Probe></Probe>` are both wrappers; only `<Probe />` allocates.

</Section>

<Test name="A component with content wraps what it is given">
<Capture as="wrapped"><Probe>inside</Probe></Capture>
<AssertEquals actual={wrapped} expected={"paired:inside"} />
</Test>

<Test name="An empty pair of tags is still the wrapping form">
<Capture as="empty"><Probe></Probe></Capture>
<AssertEquals actual={empty} expected={"paired:"} />
</Test>

<Test name="A self-closing component allocates instead of wrapping">
<Probe as="token" />
<AssertMatch actual={token} expected={/^probe-\d+$/} />
</Test>

<Test name="A retained resource is still alive for a later sibling">
<Probe as="held" />
<Capture as="state"><ProbeLive token={held} /></Capture>
<AssertEquals actual={state} expected={"live"} />
</Test>
