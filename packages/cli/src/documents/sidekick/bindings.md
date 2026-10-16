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

## Read next

Read `<Guide.Entries />` for the pattern that puts source into the shared draft,
and `<Guide.Recovery />` when continuing interrupted work.
