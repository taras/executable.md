# Lifetimes

Read this before starting a process, opening a connection, or leaving work
running in the background.

## Applies to

REPL entries. A Sidekick response holds nothing open and starts nothing that
outlives it.

## Instructions

- Everything an entry acquires belongs to the scope that acquired it. A block
  owns what it starts, a component owns what its body starts, and the entry owns
  all of it.
- `resource` is how ownership is written. Its body acquires, hands the value
  over with `yield* provide(...)`, and releases in the `finally` that follows —
  so the release is part of the thing acquired rather than a step somebody has
  to remember.
- When a scope ends, what it acquired is released, in the reverse of the order
  it was acquired. A resource a block acquires is released when that **block**
  completes — not when the expression that acquired it returns, and not when the
  entry ends.
- `persist` on an eval fence extends a resource's life from the block to the
  component's eval scope. Without it, what the block started is torn down when
  the block completes.
- An entry is not finished when its last line runs — it is finished when
  everything it held has come down. `<REPL.Submit />` waits for both, so a
  receipt means the resources are gone.
- Nothing live crosses from one entry to the next. A process, a connection or an
  open handle does not transfer: the next entry starts with none of it, which is
  what makes each entry's start a start rather than an overlap. What does cross
  is published JSON state — see `<Guide.Bindings />`.
- Stopping the Sidekick does not stop an entry that has been admitted. The entry
  keeps running and comes down on its own terms.

## Example

A complete response. The captured program acquires a resource in one block and
reads the record of its release in the next:

`````xmd
<Let as="code" select="code">
````xmd
```js eval
const events = [];
const open = yield* resource(function* (provide) {
  events.push("acquired");
  try {
    yield* provide("handle");
  } finally {
    events.push("released");
  }
});
events.push(`used ${open}`);
```

```js eval
const order = events.join(", ");
```

<Output>{order}</Output>
````
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
`````

The first block acquires the resource and uses it. The release is not written
anywhere in that block — it is the `finally` inside the resource — and it
happens when the **block** completes, which is why the second block can see it
at all. The entry prints:

```text
acquired, used handle, released
```

That ordering is the whole lesson: the block owned the resource, so the block
ending released it, well before the entry settled. Submit returns after all of
it, not merely after the last line ran.

## Common mistake

Preparing one entry that starts a server and a second entry that expects to talk
to it. The first entry's server is released when that entry ends, so the second
finds nothing. Put the work that needs the resource in the same entry that
acquires it — or, if it must outlive its block, give that fence `persist` so the
component's eval scope owns it instead. A port number is state that can cross;
a listening socket is not.

## Read next

Read `<Guide.Effection />` for how asynchronous work is written and cancelled,
and `<Guide.Recovery />` for what survives an interruption.
