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
  not the output. Read the output with `<REPL.Entry.Output />`.
- When an entry fails, its receipt points at `<REPL.Entry.Journal />` rather
  than at its output, because an entry that failed may have printed nothing.
  Read `<Guide.Recovery />` for what to do with what it answers.

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

### Create and use a session component across responses

Read `<Guide.Environment />`, `<Guide.Entries />`, `<REPL.Environment />` and
`<REPL.Syntax names={["File"]} />` first. When asked to create this component,
submit its file definition in one response:

````xmd
<Let as="code" select="code">
```xmd
<File path="components/Greeting.md">Hello from this session.</File>
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
````

Wait for the receipt and follow its read instruction to inspect the entry's
output before assuming the write succeeded. A completed entry can report a File
refusal in its output. A successful write creates exactly `Hello from this
session.` with no added newline and invokes no Greeting. Correct a reported
write failure before attempting invocation.

In a later response inspect the selected definition:

```xmd
<REPL.Syntax names={["Greeting"]} />
```

Read its selected origin. A configured component directory precedes the session
components directory, so inspect the definition that actually wins. Once the
selected definition is the intended one, submit its invocation in another
response:

````xmd
<Let as="code" select="code">
```xmd
<Greeting />
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
````

Use the receipt's returned entry reference/read instruction to read that exact
entry with `<REPL.Entry.Output />`. For example, when the receipt names
`entry-2`, a later response writes:

```xmd
<REPL.Entry.Output entry={2} />
```

The session definition prints `Hello from this session.`. Response captures
remain local to their response; the later response does not inherit `code`.

### Read the repository in an entry

An entry can ask a selected checkout four questions. Read their exact forms
with `<REPL.Syntax names={["Git.Files", "Git.Changes", "Git.Diff", "Git.File"]} />`
first. Enter the explicitly known checkout path before asking Git; the workspace
is not a hidden route back to the project. Replace `/known/project` below with
the actual known checkout path:

````xmd
<Let as="code" select="code">
```xmd
<Dir path="/known/project">
<Git.Files prefix="packages/core/" limit={5} as="files" />
<Json value={files.paths} />
</Dir>
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
<REPL.Entry.Output />
````

Each read requires `as`, renders nothing and binds JSON. A page is bounded —
100 records, or 4096 characters of text — and `next` holds the complete
arguments for continuation, or `null` when there is no more. If a later read's
cursor refuses because the answer changed, restart the read without the cursor.
Nothing these reads return authorizes a repository change.

## Common mistake

Writing the entry source directly into your response, or inside a fence marked
`exec` or `eval`, does not prepare a draft. In a response that construct is
refused, and the whole response is checked before any of its controls run — so
one prohibited fence can stop every control in the response, including ones in
a branch that would not have been taken.

## Read next

Read `<Guide.Bindings />` before reusing values an earlier entry published, and
`<Guide.Effection />` before writing entry code that performs asynchronous work.
