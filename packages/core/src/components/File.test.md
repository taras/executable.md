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

What gets written is exactly what the children rendered. Nothing is added,
trimmed, normalized, or reformatted — so where the tags sit is where the file's
first and last bytes come from. Put the content on the same line as the tags
and that is the whole file:

<Test name="Inline content is the whole file">
<TempDir>
<File path="tight.txt">one line</File>
<File path="tight.txt" as="tight" />
<AssertEquals actual={tight} expected={"one line"} />
</TempDir>
</Test>

Put it on its own line and the line breaks around it are content too, because
they are inside the element. The file starts with a newline and ends with one.

<Test name="Content on its own line keeps the newlines around it">
<TempDir>
<File path="spread.txt">
one line
</File>
<File path="spread.txt" as="spread" />
<AssertEquals actual={spread} expected={"\none line\n"} />
</TempDir>
</Test>

Indentation survives for the same reason, and so does a blank line.

<Test name="Whitespace inside the element is preserved exactly">
<TempDir>
<File path="indented.txt">
    indented
</File>
<File path="indented.txt" as="indented" />
<AssertEquals actual={indented} expected={"\n    indented\n"} />

<File path="blank.txt">
one line

</File>
<File path="blank.txt" as="blank" />
<AssertEquals actual={blank} expected={"\none line\n\n"} />
</TempDir>
</Test>

A name that merely begins with two dots is an ordinary file, not an escape.

<Test name="A name beginning with dots is an ordinary file">
<TempDir>
<File path="..notes.md">dotted</File>
<File path="..notes.md" as="dotted" />
<AssertEquals actual={dotted} expected={"dotted"} />
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
