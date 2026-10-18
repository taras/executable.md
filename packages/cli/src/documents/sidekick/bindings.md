# Bindings

Read this before using values created by earlier REPL entries, or before
carrying state from one entry to the next.

## Applies to

Sidekick responses, and the root bindings a REPL entry inherits.

## Instructions

- Read the current published values with `<REPL.Bindings />`. It returns a JSON
  map of binding names and values as feedback, then the host asks for your next
  response.
- Those are the values the acknowledged live head published, not the values of
  whichever history position a person happens to be reading.
- Each response starts with an empty binding environment. Nothing from an
  earlier response, and nothing from the REPL, is in scope automatically.
- `<Let as="name" value={...} />` creates a binding in *this* response. The
  program runs in document order, so the name exists after the `Let`.
- On a component, `as="name"` captures its return. A text component binds its
  rendered text and emits nothing at that location; a value component renders
  nothing and binds its value. Read **Returns** and **as** in the component's
  own reference rather than assuming a string.
- In text, `{name}` inserts the value's string representation. It does not
  execute JavaScript and does not re-parse the result as XMD; interpolating an
  object is not JSON serialization. Write `\{` for a literal brace. Inline
  backticks do not prevent interpolation.
- Bindings created inside a component body or an `Each` iteration do not escape
  to later siblings. Use that construct's documented return or capture.
- An entry inherits the JSON state earlier entries published, so a value an
  entry needs from an earlier one is reached by name inside the entry, not
  carried through your response.
- Inside an entry, a root `<Let as="name" value={...} />` and a root component
  capture reach the entries after it, alongside an `eval` block's exports. What
  an entry hands on is the state its root is in when it finishes, so the order
  the names were written in does not matter — only what they were at the end.
- What crosses is ordinary JSON: text, numbers, `true`, `false`, `null`, lists
  and plain objects of those. A function, a live handle, a class instance, a
  cycle, a non-finite number and `undefined` stay in the entry that made them.
  They are usable for the rest of that entry and do not cross.
- A name bound only to a value like that is absent rather than cleared, so the
  name keeps whichever value an entry last handed on. After an entry hands on
  `saved = "alpha"`, a later entry binding a function as `saved` uses that
  function and leaves `saved` as `"alpha"` for the entry after it. A name only
  ever bound to such a value is absent from `<REPL.Bindings />` entirely.
- Because it is the state at the end, a change an entry makes to a value before
  it finishes is part of what it hands on — including to a value it inherited
  and never named again. A change made after an entry finished reaches nothing.
- An entry that failed still hands on the state it had. One whose cancellation
  the file records hands on no state of its own — but it does not take back
  what it had already recorded before then, so an `eval` export it made is
  still there for the entry after it. One still running has handed on nothing
  yet.
- A history written before this was retained is read as it is: a value it never
  recorded stays absent, and nothing re-runs the entry to recover it.

## Example

```xmd
<REPL.Bindings />
```

The host returns a JSON map of published binding names and values as feedback,
then requests your next response.

## Common mistake

Receiving a binding named `names` in feedback does not make `{names}` available
in your next response. Feedback is information to reason about, not an automatic
variable. The name can be referenced inside an entry that inherits that
binding, or restated in your response with an explicit `Let`.

A second one: a name missing from `<REPL.Bindings />` is a name nothing handed
on, not a name something removed. There is no way to delete a retained value —
write an entry that ends with the value you want under that name instead of
expecting an absence to clear it.

## Read next

Read `<Guide.Entries />` for the pattern that puts source into the shared draft,
and `<Guide.Recovery />` when continuing interrupted work.
