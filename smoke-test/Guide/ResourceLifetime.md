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

Each scenario checks the whole lifetime in one test — nothing live
before, the invocation, then what remains — so no scenario depends on
what another left behind.

</Section>

A standalone `<Thing />` returns a handle, but with invocation lifetime
the resource behind it is gone by the time the next line reads it.

<Test name="A standalone Thing's resource does not outlive it">
<Capture as="before"><ThingState /></Capture>
<Thing as="handle" />
<Capture as="after"><ThingState /></Capture>
<Capture as="mine"><ThingHandle handle={handle} /></Capture>
<AssertEquals actual={before} expected={"none"} />
<AssertMatch actual={handle} expected={/^thing-\d+$/} />
<AssertEquals actual={after} expected={"none"} />
<AssertEquals actual={mine} expected={"released"} />
</Test>

An empty pair of tags is still content, so `<Thing></Thing>` is the
wrapping form. It renders nothing and owns its resource, which means
nothing survives it.

<Test name="An empty paired Thing renders nothing and keeps nothing">
<Capture as="before"><ThingState /></Capture>
<Capture as="rendered"><Thing></Thing></Capture>
<Capture as="after"><ThingState /></Capture>
<AssertEquals actual={before} expected={"none"} />
<AssertEquals actual={rendered} expected={""} />
<AssertEquals actual={after} expected={"none"} />
</Test>

While a wrapper's content expands, its resource is live — the content
asks from inside — and it is released as soon as the wrapping finishes.

<Test name="A paired Thing's resource is live only while its content expands">
<Capture as="before"><ThingState /></Capture>
<Capture as="inside"><Thing><ThingState /></Thing></Capture>
<Capture as="after"><ThingState /></Capture>
<AssertEquals actual={before} expected={"none"} />
<AssertEquals actual={inside} expected={"live"} />
<AssertEquals actual={after} expected={"none"} />
</Test>
