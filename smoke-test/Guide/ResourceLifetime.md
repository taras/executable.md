<Section title="Resource Lifetime">

A TypeScript component acquires resources with ordinary Effection
operations, and the invocation boundary releases them when it finishes.
`<Thing>` acquires one either way it is written.

Which form is running comes from how the element was written, not from
what it renders: `<Thing>…</Thing>` and `<Thing></Thing>` are both
wrappers, and only `<Thing />` is standalone. A wrapper's resource is
alive exactly while its content expands — which is what a wrapper wants.

A standalone `<Thing />` is a different story. It hands back a handle
the document uses *afterwards*, and invocation lifetime has already
released the resource by then. The scenarios below observe that rather
than hiding it.

Each scenario is its own test, so the previous one's resources are
already released when the next begins.

</Section>

Nothing has run yet, so nothing is live.

<Test name="No resource exists before a standalone Thing">
<Capture as="before"><ThingState /></Capture>
<AssertEquals actual={before} expected={"none"} />
</Test>

A standalone `<Thing />` returns a handle, but with invocation lifetime
the resource behind it is gone by the time the next line reads it.

<Test name="A standalone Thing's resource does not outlive it">
<Thing as="handle" />
<Capture as="state"><ThingState /></Capture>
<Capture as="mine"><ThingHandle handle={handle} /></Capture>
<AssertMatch actual={handle} expected={/^thing-\d+$/} />
<AssertEquals actual={state} expected={"none"} />
<AssertEquals actual={mine} expected={"released"} />
</Test>

The previous test released everything it acquired, so this one starts
clean.

<Test name="No resource exists before a paired Thing">
<Capture as="before"><ThingState /></Capture>
<AssertEquals actual={before} expected={"none"} />
</Test>

An empty pair of tags is still content, so `<Thing></Thing>` is the
wrapping form. It renders nothing and owns its resource, which means
nothing survives it.

<Test name="A paired Thing releases its resource when it finishes">
<Capture as="rendered"><Thing></Thing></Capture>
<Capture as="after"><ThingState /></Capture>
<AssertEquals actual={rendered} expected={""} />
<AssertEquals actual={after} expected={"none"} />
</Test>

While a wrapper's content expands, its resource is live — the content
below asks, from inside.

<Test name="A paired Thing's resource is live while its content expands">
<Capture as="inside"><Thing><ThingState /></Thing></Capture>
<Capture as="after"><ThingState /></Capture>
<AssertEquals actual={inside} expected={"live"} />
<AssertEquals actual={after} expected={"none"} />
</Test>
