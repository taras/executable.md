<Section title="Resource Lifetime">

A TypeScript component acquires resources with ordinary Effection
operations, and the invocation boundary releases them when it finishes.
`<Thing>` acquires one either way it is written — what changes is who
owns it.

Which form is running comes from how the element was written, not from
what it renders: `<Thing>…</Thing>` and `<Thing></Thing>` are both
wrappers, and only `<Thing />` is standalone. A wrapper's resource is
alive exactly while its content expands and released when the wrapping
finishes — the ordinary invocation lifetime, which is what a wrapper
wants.

A standalone `<Thing />` needs the opposite. It hands back a handle the
document uses *afterwards*, so releasing the resource at the boundary
would return a name for something that no longer exists. It asks for
the resource with `retain()` instead, and the resource lives as long as
the scope that invoked it.

Each scenario checks the whole lifetime in one test — nothing live
before, the invocation, then what remains — so no scenario depends on
what another left behind.

</Section>

A standalone `<Thing />` returns its handle and leaves the resource
running, so the document can still use it further down.

<Test name="A standalone Thing's resource outlives it">
<Let as="before"><ThingState /></Let>
<Thing as="handle" />
<Let as="after"><ThingState /></Let>
<Let as="mine"><ThingHandle handle={handle} /></Let>
<AssertEquals actual={before} expected={"none"} />
<AssertMatch actual={handle} expected={/^thing-\d+$/} />
<AssertEquals actual={after} expected={"live"} />
<AssertEquals actual={mine} expected={"live"} />
</Test>

An empty pair of tags is still content, so `<Thing></Thing>` is the
wrapping form. It renders nothing and owns its resource, which means
nothing survives it.

<Test name="An empty paired Thing renders nothing and keeps nothing">
<Let as="before"><ThingState /></Let>
<Let as="rendered"><Thing></Thing></Let>
<Let as="after"><ThingState /></Let>
<AssertEquals actual={before} expected={"none"} />
<AssertEquals actual={rendered} expected={""} />
<AssertEquals actual={after} expected={"none"} />
</Test>

While a wrapper's content expands, its resource is live — the content
asks from inside — and it is released as soon as the wrapping finishes.

<Test name="A paired Thing's resource is live only while its content expands">
<Let as="before"><ThingState /></Let>
<Let as="inside"><Thing><ThingState /></Thing></Let>
<Let as="after"><ThingState /></Let>
<AssertEquals actual={before} expected={"none"} />
<AssertEquals actual={inside} expected={"live"} />
<AssertEquals actual={after} expected={"none"} />
</Test>
