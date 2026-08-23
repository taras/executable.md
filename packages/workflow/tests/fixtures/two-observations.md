# Two observations, one document

An Agent proposed one fragment here and another below. Each is admitted at its
own site: the durable name of an admission is the invocation the engine entered,
so a replay restores the fragment *this* site admitted and never the other's.

<Evaluate source={'<File path="alpha.md" />'} as="first" />

<Json value={first} />

<Evaluate source={'<Fetch url="https://api.example.test/admitted" />'} as="second" />

<Json value={second} />
