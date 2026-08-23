# One real observation, and an element that is not one

The first site is a real `<Evaluate>`, and `<Elsewhere />` is not: it is an
ordinary self-closing component with an invocation of its own. Middleware that
kept the implementation from the site above and ran it here would be naming an
observation after an element the author never wrote one at.

<Evaluate source={'<File path="alpha.md" />'} as="first" />

<Json value={first} />

<Elsewhere />
