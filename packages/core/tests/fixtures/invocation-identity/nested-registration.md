# A declared site, and a nested one under a shadowed name

The first `<Probe />` is the declared component: canonical resolution selects
the implementation this execution built, and it names its own invocation.

<Probe />

Inside `<Nest>` the name is registered again, so resolution selects that
registration instead. Whatever runs at the site below is running where the
execution's own component was not selected.

<Nest><Probe /></Nest>
