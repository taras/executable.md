# File

`<File>` reads and writes UTF-8 text at a path relative to the contextual
working directory. Every test below runs inside a `<TempDir>` and names its
files relatively, so what they demonstrate is both halves of that sentence:
the component's own behavior, and that `<TempDir>` really does supply the
`Env.cwd` its descendants resolve against.

Written with content, `<File>` writes and renders nothing. Written
self-closing, it reads and renders the text it read.

<Test name="A file written inside TempDir reads back">
<TempDir>
<File path="request.md">Request content</File>
<Capture as="rendered"><File path="request.md" /></Capture>
<AssertEquals actual={rendered} expected={"Request content"} />
</TempDir>
</Test>

`as` captures the text instead of rendering it, like any other component that
returns text.

<Test name="as captures the content that was read">
<TempDir>
<File path="request.md">Request content</File>
<File path="request.md" as="request" />
<AssertEquals actual={request} expected={"Request content"} />
</TempDir>
</Test>

A write creates whatever parent directories the path names.

<Test name="Writing creates missing parent directories">
<TempDir>
<File path="fixtures/nested/request.md">nested</File>
<File path="fixtures/nested/request.md" as="nested" />
<AssertEquals actual={nested} expected={"nested"} />
</TempDir>
</Test>

Writing again replaces the file. Nothing of the previous content survives,
and writing the same content twice leaves the same file.

<Test name="Writing replaces the previous content">
<TempDir>
<File path="notes.md">first</File>
<File path="notes.md">second</File>
<File path="notes.md">second</File>
<File path="notes.md" as="notes" />
<AssertEquals actual={notes} expected={"second"} />
</TempDir>
</Test>

The text written is what the children rendered, with the line break after the
opening tag and the one before the closing tag removed — those belong to the
markup. Nothing else is touched: no trailing newline is added, and nothing is
reformatted. So the two ways of writing the same file write the same bytes.

<Test name="The two authoring forms write the same bytes">
<TempDir>
<File path="tight.txt">one line</File>
<File path="tight.txt" as="tight" />
<AssertEquals actual={tight} expected={"one line"} />

<File path="spread.txt">
one line
</File>
<File path="spread.txt" as="spread" />
<AssertEquals actual={spread} expected={"one line"} />
</TempDir>
</Test>

A blank line before the closing tag is content, so that is how a file ends
with a newline. Indentation inside the element survives too.

<Test name="Nothing beyond the framing newlines is trimmed">
<TempDir>
<File path="trailing.txt">
one line

</File>
<File path="trailing.txt" as="trailing" />
<AssertEquals actual={trailing} expected={"one line\n"} />

<File path="indented.txt">
    indented
</File>
<File path="indented.txt" as="indented" />
<AssertEquals actual={indented} expected={"    indented"} />
</TempDir>
</Test>

The directory `<File>` resolves against is the one `<TempDir>` installed, not
the process's own. A shell running in the same block finds the file where
`<File>` put it, and `<File>` reads back what the shell wrote.

<Test name="File and the shell share the contextual directory">
<TempDir>
<File path="note.txt">written by File</File>
<Capture as="seen">
```sh exec
cat note.txt
echo "written by the shell" > from-shell.txt
```
</Capture>
<AssertStringIncludes actual={seen} expected={"written by File"} />
<File path="from-shell.txt" as="fromShell" />
<AssertEquals actual={fromShell} expected={"written by the shell\n"} />
</TempDir>
</Test>

Two `<TempDir>` siblings share nothing. The second one names the same relative
path the first wrote, and finds nothing there.

<Test name="Temporary directories do not share files">
<TempDir>
<File path="note.txt">first</File>
<File path="note.txt" as="first" />
<AssertEquals actual={first} expected={"first"} />
</TempDir>

<TempDir>
<Capture as="listing">
```sh exec
test -f note.txt && echo PRESENT || echo ABSENT
```
</Capture>
<AssertStringIncludes actual={listing} expected={"ABSENT"} />
</TempDir>
</Test>
