# Two evaluations, one document

An Agent proposed one fragment here and another below. Each is admitted at its
own site: the durable name of an admission is the invocation the engine entered,
so a replay restores the fragment *this* site admitted and never the other's.

The first fragment renders its read where it wrote it, so the binding here holds
that text. The second binds its response inside the fragment and renders it
through `<Json>`, because a `<Fetch>` returns a value rather than text and
nothing collects one on the fragment's behalf.

<Evaluate source={'<File path="alpha.md" />'} as="first" />

<Json value={first} />

<Evaluate source={'<Fetch url="https://api.example.test/admitted" as="response" />\n\n<Json value={response} />'} as="second" />

<Json value={second} />
