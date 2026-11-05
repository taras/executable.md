# Entries

Read this before preparing an entry for the first time, or whenever you need the
authoring pattern for preparing, testing and reusing session components.

## Applies to

Sidekick responses that write an entry, and the REPL entry program they write.

## Instructions

- Your response and the entry you prepare are two different XMD documents. A
  component admitted in an entry is not thereby admitted in your response. List
  the entry vocabulary with `<REPL.Syntax />` and read a named component with
  `<REPL.Syntax names={["Elicit"]} />`. Availability means the component resolves
  in an ordinary entry; each effect still requires permission and can fail.
  Fresh asks read current session components and this command's selected Plugins.
- Use existing assertions such as `<Assert>`, `<AssertEquals>` and `<AssertThrows>`
  directly in ordinary entries. A failing assertion fails that entry and stops
  later ordinary effects. Assertions do not activate testing.
- Use `Test`, `Testing` and the nested test harness in Markdown test documents
  requested through `<REPL.Test />`. A bare `<Test>` in an ordinary entry refuses
  without running its body or activating testing.
- Quoted props are strings: `as="code"`. Braced props supply data:
  `limit={16384}`, `entry={-2}`, `names={["Elicit"]}`.
- In a response, braced props accept JSON literals, arrays, objects, object
  shorthand and bindings this response already created. They do not execute
  JavaScript: no calls, property access, indexing, operators, template literals
  or arrow functions. `value={choice}` passes a binding; `value={choice.answer}`
  does not.
- A fenced block with no `exec` or `eval` modifier is passive text, including
  its tags and braces. The language label alone does not make a fence
  executable. References inside it stay literal even when your response or an
  entry already bound the same names. Executable fences are unavailable in a
  response.
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
<Let as="names" value={["response-only"]} />
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
The response's `names` does not replace `{names}` in the fenced source. The
entry binds its own `names` when run; `code` belongs to this response.
`select="code"` extracts the first matching fenced block without its
fence, and trims trailing whitespace — pass a direct string value when exact
string boundaries matter.

Use a longer outer fence when the saved entry contains an executable block:

`````xmd
<Let as="code" select="code">
````xmd
<Let as="message" value="hello" />
```sh exec
printf '%s\n' {message}
```
````
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
`````

This fills the draft with the Let and exec block as source. Explicit submission
runs that entry, where `{message}` resolves to `hello`.

### Capture command and component results

Use `exec as="commandResult"` to capture exitCode, stdout and stderr separately.
A nonzero captured exitCode is data. A command that cannot start, times out or
is cancelled still fails and binds no result. A component's `as` captures its
rendered text. Submit this complete response in a fresh session:

`````xmd
<Let as="code" select="code">
````xmd
```sh exec as="commandResult"
printf out
printf err >&2
exit 7
```
<File path="capture-demo.txt">component text</File>
<File path="capture-demo.txt" as="componentOutput" />
<Output><Json value={{exitCode: commandResult.exitCode, stdout: commandResult.stdout, stderr: commandResult.stderr, componentOutput}} /></Output>
````
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
`````

Follow the actual receipt's read instruction. In this fresh session it names:

```xmd
<REPL.Entry.Output entry={1} offset={0} />
```

The page text has exitCode=7, stdout="out", stderr="err" and
componentOutput="component text". A Submit receipt contains no entry output.
Use `offset={0}` to read complete output from its beginning. When the page
returns `next`, pass those exact arguments to the next read and
concatenate its text. Use the actual receipt's entry in an existing session.

`<Cwd />` renders the current directory with no newline. `<Cwd as="directory" />`
captures the same text without rendering it at that position. These reads require
no filesystem permission. A definition invoked later observes its caller's cwd.

### Create and use a session component across responses

Read `<Guide.Environment />`, `<Guide.Entries />`, `<REPL.Environment />` and
`<REPL.Syntax names={["File"]} />` first. When asked to create this component,
submit its file definition in one response:

````xmd
<Let as="code" select="code">
```xmd
<REPL.ComponentDir><File path="Greeting.md">Hello from this session.</File></REPL.ComponentDir>
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
first. Ambient Git reads start in the selected launch project. A lexical
Repository or Worktree selects its own checkout. For another checkout inside
your project, replace `RELATIVE_CHECKOUT` below with its observed project-relative
path. Absolute Dir still requires opt-in and effective write permission:

````xmd
<Let as="code" select="code">
```xmd
<Dir path="RELATIVE_CHECKOUT">
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

### Acquire a repository for later entries

Read `<Guide.Environment />`, `<REPL.Environment />` and
`<REPL.Syntax names={["Repository", "File"]} />` first. Replace the example
locator and creation base below with the selected repository and resolved commit:

````xmd
<Let as="code" select="code">
```xmd
<Repository name="project" url="/known/repository" base="KNOWN_COMMIT" as="checkout" />
{checkout}
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
````

Follow the receipt's read instruction and inspect the actual outcome and checkout
binding. An entry can print a refusal; status alone proves no acquisition.
Repository and Worktree selection have their own authenticated Git owner.
Sidekick File work remains confined to the selected launch project and the two
session scopes. A checkout outside those roots cannot be read through File;
selection alone grants no file authority. Git reads keep their existing owner.
An acknowledged old read answers with its historical text without fresh Git work.

For a returned checkout inside your launch project, derive its project-relative
address and replace `RELATIVE_CHECKOUT` below. This later response reads its
current working file without acquiring again:

````xmd
<Let as="code" select="code">
```xmd
<File path="RELATIVE_CHECKOUT/README.md" as="readme" />
{readme}
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
````

For an outside checkout, use authenticated Git reads in its lexical Repository
scope. It is unavailable to ordinary Sidekick File work. Current HEAD and local
changes survive compatible re-selection; `base` is the creation base. A different
origin or creation base refuses without resetting the checkout.

### Test, fix and reuse a session component

When asked to create and test a component, write its definition and a companion
Markdown test through ComponentDir in an ordinary entry. Greeting returns its
greeting when invoked. Authoring its file invokes neither Greeting nor Test:

````xmd
<Let as="code" select="code">
```xmd
<Let as="definition" value="Hello from this session." />
<REPL.ComponentDir><File path="Greeting.md">{definition}</File></REPL.ComponentDir>
<Let as="test" value={"<Test name=\"greeting\"><Greeting as=\"actual\" /><AssertEquals actual={actual} expected=\"Hello from this session.\" /></Test>"} />
<REPL.ComponentDir><File path="Greeting.test.md">{test}</File></REPL.ComponentDir>
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
````

Follow the receipt's read instruction and check the actual File outcomes. A
completed entry alone does not prove either write succeeded. Authoring the test
has run no assertion.

After successful writes, request the document explicitly:

````xmd
<REPL.Test path="components/Greeting.test.md" />
````

Feedback contains a passed document and its named assertion. Tests start in
the session directory. File fixtures belong under `components/fixtures`; other
private session files remain unavailable. Testing uses the command's permissions; it does not append an entry or consume the draft.

To see a real failure, replace the expectation through another ordinary entry,
then request the directory suite:

````xmd
<Let as="code" select="code">
```xmd
<Let as="test" value={"<Test name=\"greeting\"><Greeting as=\"actual\" /><AssertEquals actual={actual} expected=\"wrong\" /></Test>"} />
<REPL.ComponentDir><File path="Greeting.test.md">{test}</File></REPL.ComponentDir>
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
<REPL.Test path="components" as="tests" />
````

The completed report is `failed`. Read the named assertion's full diagnostic,
actual and expected values before changing the file. Fix that expectation and
request a fresh suite:

````xmd
<Let as="code" select="code">
```xmd
<Let as="test" value={"<Test name=\"greeting\"><Greeting as=\"actual\" /><AssertEquals actual={actual} expected=\"Hello from this session.\" /></Test>"} />
<REPL.ComponentDir><File path="Greeting.test.md">{test}</File></REPL.ComponentDir>
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
<REPL.Test path="components" />
````

A passed report belongs to this request. Earlier failed reports stay as facts.
You can now invoke the component in a later ordinary entry without includes,
pasted definitions or a restart:

````xmd
<Let as="code" select="code">
```xmd
<Greeting />
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
<REPL.Submit />
````

The entry returns `Hello from this session.`. A person can also enter
`<Greeting />` manually. Both use the selected component; configured directories
still precede session components during a test, including a directory suite.

Use `as` when this response needs the structured report. Capturing and leaving
it uncaptured both deliver the same feedback and publish no chat. To show it to
the person explicitly, write:

```xmd
<REPL.Test path="components" as="tests" />
<Output><Json value={tests} /></Output>
```

`no-tests` means no document matched, or otherwise valid documents reached no
Test. It is not a pass. A parse or runtime error before the first Test is a
failed document; inspect its `error` and any partial `report`. An admission or
discovery refusal produces a diagnostic instead of a completed report. Wait for
entry or test cleanup to finish before requesting another run. Stop cancels and
joins response-owned tests; it leaves an already admitted ordinary entry alone.

## Common mistake

Writing the entry source directly into your response, or inside a fence marked
`exec` or `eval`, does not prepare a draft. In a response that construct is
refused, and the whole response is checked before any of its controls run — so
one prohibited fence can stop every control in the response, including ones in
a branch that would not have been taken.

## Read next

Read `<Guide.Bindings />` before reusing values an earlier entry published, and
`<Guide.Effection />` before writing entry code that performs asynchronous work.
