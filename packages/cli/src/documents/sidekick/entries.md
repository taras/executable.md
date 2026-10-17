# Entries

Read this before preparing an entry for the first time, or whenever you need the
authoring pattern for putting source into the shared draft.

## Applies to

Sidekick responses that write an entry, and the REPL entry program they write.

## Instructions

- Your response and the entry you prepare are two different XMD documents. A
  component admitted in an entry is not thereby admitted in your response. List
  the entry vocabulary with `<REPL.Syntax />` and read a named component with
  `<REPL.Syntax names={["Elicit"]} />`.
- Quoted props are strings: `as="code"`. Braced props supply data:
  `limit={16384}`, `entry={-2}`, `names={["Elicit"]}`.
- In a response, braced props accept JSON literals, arrays, objects, object
  shorthand and bindings this response already created. They do not execute
  JavaScript: no calls, property access, indexing, operators, template literals
  or arrow functions. `value={choice}` passes a binding; `value={choice.answer}`
  does not.
- A fenced block with no `exec` or `eval` modifier is passive text, including
  its tags and braces. The language label alone does not make a fence
  executable, and executable fences are unavailable in a response.
- Capture passive source with `<Let as="code" select="code">`, then pass the
  captured string to `<REPL.EntryInput>`. That fills the shared draft and runs
  none of it.
- If the entry source itself contains fenced blocks, enclose it in a longer
  fence, and leave `exec` and `eval` off the enclosing fence.
- Add `<REPL.Submit />` after `<REPL.EntryInput>` only when the request calls
  for execution. Submit runs the actual shared draft, waits for that entry to
  finish and release its resources, and returns status and a read instruction —
  not the output. Read the output with `<REPL.EntryOutput />`.

## Example

````xmd
<Let as="code" select="code">
```xmd
<Let as="names" value={["Ada", "Lin"]} />
<Output>
<Each in={names} let="name">
Hello, {name}!
</Each>
</Output>
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
````

The shared draft now holds that program as literal source and nothing has run.
The `names` binding belongs to the future entry; `code` belongs to this
response. `select="code"` extracts the first matching fenced block without its
fence, and trims trailing whitespace — pass a direct string value when exact
string boundaries matter.

## Common mistake

Writing the entry source directly into your response, or inside a fence marked
`exec` or `eval`, does not prepare a draft. In a response that construct is
refused, and the whole response is checked before any of its controls run — so
one prohibited fence can stop every control in the response, including ones in
a branch that would not have been taken.

## Read next

Read `<Guide.Bindings />` before reusing values an earlier entry published, and
`<Guide.Effection />` before writing entry code that performs asynchronous work.
