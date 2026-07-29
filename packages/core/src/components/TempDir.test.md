# TempDir

`<TempDir>` gives its content an isolated working directory and removes it
afterwards. Everything expanded inside observes it — including the shell —
so the story below is told entirely by commands reporting where they ran.

Outside any `<TempDir>`, a command runs where the document was invoked from,
so it sees no temporary directory at all.

<Test name="Execution starts in the ordinary working directory">
<Capture as="before">
```sh exec
pwd
```
</Capture>
<AssertNotMatch actual={before} expected={/xmd-tempdir-/} />
</Test>

Inside, the same command reports a directory belonging to that invocation,
and that directory is there while the command runs.

<Test name="Inside TempDir a command runs in a live temporary directory">
<Capture as="inside">
<TempDir>
```sh exec
pwd
test -d "$PWD" && echo LIVE
```
</TempDir>
</Capture>
<AssertMatch actual={inside} expected={/xmd-tempdir-/} />
<AssertStringIncludes actual={inside} expected={"LIVE"} />
</Test>

Once the component finishes, its directory is gone and the ordinary working
directory is back. The path is carried out of the block by capturing it, then
tested from outside.

<Test name="After TempDir the directory is gone and the old cwd is restored">
<Capture as="path">
<TempDir>
```sh exec
pwd
```
</TempDir>
</Capture>
<Capture as="after">
```sh exec
test -d {path} || echo REMOVED
pwd
```
</Capture>
<AssertStringIncludes actual={after} expected={"REMOVED"} />
<AssertNotMatch actual={after} expected={/xmd-tempdir-/} />
</Test>

A self-closing `<TempDir />` has no content to wrap. It renders its path and
keeps the directory, so a later sibling can still use it.

<Test name="A captured TempDir stays live for a following sibling">
<TempDir as="workspace" />
<Capture as="present">
```sh exec
test -d {workspace} && echo PRESENT
```
</Capture>
<AssertMatch actual={workspace} expected={/xmd-tempdir-/} />
<AssertStringIncludes actual={present} expected={"PRESENT"} />
</Test>

Without `as` the same form simply renders the path.

<Test name="A bare TempDir renders its path">
<Capture as="rendered"><TempDir /></Capture>
<AssertMatch actual={rendered} expected={/xmd-tempdir-/} />
</Test>
