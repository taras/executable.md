# TempDir

`<TempDir>` gives its content an isolated working directory and removes it
afterwards. Everything expanded inside observes it — including the shell —
so the story below is told entirely by commands reporting where they ran.

Outside any `<TempDir>`, a command runs where the document was invoked from,
so it sees no temporary directory at all.

<Test name="Execution starts in the ordinary working directory">
<Let as="before">
```sh exec
pwd
```
</Let>
<AssertNotMatch actual={before} expected={/xmd-tempdir-/} />
</Test>

Inside, the same command reports a directory belonging to that invocation,
and that directory is there while the command runs.

<Test name="Inside TempDir a command runs in a live temporary directory">
<Let as="inside">
<TempDir>
```sh exec
pwd
test -d "$PWD" && echo LIVE
```
</TempDir>
</Let>
<AssertMatch actual={inside} expected={/xmd-tempdir-/} />
<AssertStringIncludes actual={inside} expected={"LIVE"} />
</Test>

Once the component finishes, its directory is gone and the ordinary working
directory is back. The path is carried out of the block by capturing it, then
tested from outside.

<Test name="After TempDir the directory is gone and the old cwd is restored">
<Let as="path">
<TempDir>
```sh exec
pwd
```
</TempDir>
</Let>
<Let as="after">
```sh exec
test -d {path} || echo REMOVED
pwd
```
</Let>
<AssertStringIncludes actual={after} expected={"REMOVED"} />
<AssertNotMatch actual={after} expected={/xmd-tempdir-/} />
</Test>

A self-closing `<TempDir />` has no content to wrap. It renders its path and
keeps the directory, so a later sibling can still use it.

<Test name="A captured TempDir stays live for a following sibling">
<TempDir as="workspace" />
<Let as="present">
```sh exec
test -d {workspace} && echo PRESENT
```
</Let>
<AssertMatch actual={workspace} expected={/xmd-tempdir-/} />
<AssertStringIncludes actual={present} expected={"PRESENT"} />
</Test>

Without `as` the same form simply renders the path.

<Test name="A bare TempDir renders its path">
<Let as="rendered"><TempDir /></Let>
<AssertMatch actual={rendered} expected={/xmd-tempdir-/} />
</Test>

The directory belongs to the invocation, and so does everything the content
starts inside it. A daemon written by the caller is stopped before the
directory is removed, never after — a background process is never left
reaching for a directory that is already gone. The daemon reports what it saw
when it was signalled, into a second directory that outlives the first.

<Test name="A daemon in the content stops before the directory is removed">
<TempDir as="report" />
<TempDir>
```sh daemon exec
directory="$(pwd)"
trap 'if [ -d "$directory" ]; then echo ALIVE > {report}/observed; else echo GONE > {report}/observed; fi; exit 0' TERM
echo "$directory" > {report}/directory
while true; do sleep 0.1; done
```
```sh exec
i=0
while [ ! -s {report}/directory ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
echo watching
```
</TempDir>
<Let as="afterwards">
```sh exec
cat {report}/observed
test -d "$(cat {report}/directory)" || echo REMOVED
```
</Let>
<AssertStringIncludes actual={afterwards} expected={"ALIVE"} />
<AssertStringIncludes actual={afterwards} expected={"REMOVED"} />
</Test>
