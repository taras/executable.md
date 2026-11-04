# Bindings

Read this before drafting entries that handle large records or reports, or
before reusing values created by earlier REPL entries.

## Applies to

Sidekick responses, and the root bindings a REPL entry inherits.

## Instructions

TEMPORARY (https://github.com/taras/executable.md/issues/999): keep large
workflow records, logs, artifacts and reports in workspace files. Root bindings
retain ordinary file paths/references and only small necessary summaries or
status. Do not put full large text, parsed objects or successive checkpoint
copies at root.

Read, parse and process only what the entry needs inside an existing component
body or `Each` iteration, and capture only the compact result at root. `Let`,
`If` and `Output` do not create a local binding scope. A path is an ordinary
value: a later entry must explicitly read the file again. It provides neither
automatic lazy loading nor permission to read it.

This workaround prevents new large root bindings; existing root values and
retained history remain. Switching variable names or evicting workflow caches
does not clear those values. Local bindings do not make arbitrary large reads
safe. Remove this TEMPORARY size workaround when #999 satisfies its safe
file-backed/deduplicated binding contract; ordinary file-reference guidance may
remain.

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
- Passive fenced source preserves its tags, references and escaped braces even
  when the response or entry has already bound the same names. Capture it with
  `<Let as="code" select="code">` for later execution; use a longer outer fence
  when that source contains fences of its own. Read `<Guide.Entries />` for the
  complete authoring pattern.
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

### Keep file contents local to one iteration

Read `<Guide.Environment />` and `<Guide.Entries />`, and inspect
`<REPL.Syntax names={["File", "Json", "Parse"]} />` before preparing file work.
This complete response prepares an entry that writes or replaces
`artifacts/bindings-demo.json` in the session workspace when submitted. The tiny
report demonstrates binding placement; it is not a large-file processing recipe.

````xmd
<Let as="code" select="code">
```xmd
<Let as="reportPath" value="artifacts/bindings-demo.json" />
<File path={reportPath}>
<Json value={{status: "ready", details: ["demonstration report"]}} />
</File>
<Each in={[reportPath]} let="path" as="statusSummary">
<File path={path} as="reportText" />
<Parse schema={{type: "object", properties: {status: {type: "string"}, details: {type: "array", items: {type: "string"}}}, required: ["status", "details"], additionalProperties: false}} as="report">{reportText}</Parse>
{report.status}
</Each>
<Output>
Report status: {statusSummary}

Report file: {reportPath}
</Output>
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
````

The response fills the draft once and executes none of it. After you submit the
entry, its output reports status `ready` and path
`artifacts/bindings-demo.json`. Only `reportPath` and the short captured text
`statusSummary` reach root; the capture can include surrounding whitespace.
`path`, `reportText` and the parsed `report` belong to the one `Each` iteration.
The next entry receives the path and summary, and must explicitly read the file
if it needs its contents.

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
