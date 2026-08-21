# Glob

`<Glob>` finds files under the contextual working directory. Every test below
builds its whole fixture with `<TempDir>` and `<File>` and then asks `<Glob>`
what is there, so what each one demonstrates is the matching contract itself —
no host repository, no paths that mean something only on one machine.

`<Glob>` declares a return value, so it renders nothing and `as` binds the
`string[]` it found.

<Test name="One include pattern finds the files it names">
<TempDir>
<File path="a.md">a</File>
<File path="b.md">b</File>
<File path="notes.txt">t</File>
<Glob include={["*.md"]} as="markdown" />
<AssertEquals actual={markdown} expected={["a.md", "b.md"]} />
</TempDir>
</Test>

Several include patterns are a union: a file matched by any of them is in the
result.

<Test name="Several include patterns union their matches">
<TempDir>
<File path="a.md">a</File>
<File path="notes.txt">t</File>
<File path="image.png">p</File>
<Glob include={["*.md", "*.txt"]} as="text" />
<AssertEquals actual={text} expected={["a.md", "notes.txt"]} />
</TempDir>
</Test>

A union is a set, so a file two patterns both match is still one result. `*.md`
and `**/*.md` both match `a.md`; `AGENTS.md` names it a third time.

<Test name="Overlapping include patterns do not repeat a file">
<TempDir>
<File path="AGENTS.md">a</File>
<Glob include={["AGENTS.md", "*.md", "**/*.md"]} as="agents" />
<AssertEquals actual={agents} expected={["AGENTS.md"]} />
</TempDir>
</Test>

`*` stops at a separator and `**` crosses them, which is the difference between
searching one directory and searching a tree.

<Test name="A single star stays in one directory and ** crosses them">
<TempDir>
<File path="top.md">t</File>
<File path="one/nested.md">n</File>
<File path="one/two/deep.md">d</File>
<Glob include={["*.md"]} as="shallow" />
<AssertEquals actual={shallow} expected={["top.md"]} />

<Glob include={["**/*.md"]} as="everywhere" />
<AssertEquals
  actual={everywhere}
  expected={["one/nested.md", "one/two/deep.md", "top.md"]}
/>
</TempDir>
</Test>

The rest of the dialect is the glob library's own — `<Glob>` adds no syntax of
its own, so `?` matches one character and `{a,b}` is an alternation.

<Test name="The dialect's other operators are the library's">
<TempDir>
<File path="a.md">a</File>
<File path="bb.md">bb</File>
<File path="docs/guide.md">g</File>
<Glob include={["?.md"]} as="single" />
<AssertEquals actual={single} expected={["a.md"]} />

<Glob include={["{a,docs/guide}.md"]} as="alternation" />
<AssertEquals actual={alternation} expected={["a.md", "docs/guide.md"]} />
</TempDir>
</Test>

`**/` matches no directories as readily as many, so one pattern finds a name
wherever it sits — at the top and nested at any depth.

<Test name="**/ matches a name at the top and at any depth">
<TempDir>
<File path="AGENTS.md">root</File>
<File path="packages/AGENTS.md">package</File>
<File path="packages/core/src/AGENTS.md">source</File>
<File path="README.md">readme</File>
<Glob include={["**/AGENTS.md"]} as="instructions" />
<AssertEquals
  actual={instructions}
  expected={["AGENTS.md", "packages/AGENTS.md", "packages/core/src/AGENTS.md"]}
/>
</TempDir>
</Test>

Results are paths relative to the working directory, written with `/` on every
platform, so a document can hand one straight back to `<File>`.

<Test name="A result is a relative path File can read">
<TempDir>
<File path="one/two/deep.md">deep content</File>
<Glob include={["**/*.md"]} as="found" />
<AssertEquals actual={found} expected={["one/two/deep.md"]} />
<File path="one/two/deep.md" as="text" />
<AssertEquals actual={text} expected={"deep content"} />
</TempDir>
</Test>

`exclude` wins over `include`. The same `**/*.md` that found the whole tree
above finds only what is left after an exclusion removes a subtree.

<Test name="Exclusions win over inclusions">
<TempDir>
<File path="keep.md">k</File>
<File path="vendor/skip.md">s</File>
<File path="vendor/deep/skip.md">s</File>
<Glob include={["**/*.md"]} exclude={["vendor/**"]} as="mine" />
<AssertEquals actual={mine} expected={["keep.md"]} />
</TempDir>
</Test>

An exclusion removes exactly the files its own pattern matches. `*` may match
nothing but never crosses a separator, so `vendor/*` removes the files directly
inside `vendor` and leaves what is deeper — the exclusion is read as written, not
widened to the whole subtree.

<Test name="An exclusion that stops at a separator keeps deeper files">
<TempDir>
<File path="keep.md">k</File>
<File path="vendor/skip.md">s</File>
<File path="vendor/deep/keep.md">d</File>
<Glob include={["**/*.md"]} exclude={["vendor/*"]} as="kept" />
<AssertEquals actual={kept} expected={["keep.md", "vendor/deep/keep.md"]} />
</TempDir>
</Test>

For the same reason, an exclusion naming only a directory removes nothing:
directories are never results, so `vendor` has no file to match, and everything
below it stays.

<Test name="An exclusion naming only a directory removes nothing">
<TempDir>
<File path="keep.md">k</File>
<File path="vendor/skip.md">s</File>
<File path="vendor/deep/keep.md">d</File>
<Glob include={["**/*.md"]} exclude={["vendor"]} as="all" />
<AssertEquals
  actual={all}
  expected={["keep.md", "vendor/deep/keep.md", "vendor/skip.md"]}
/>
</TempDir>
</Test>

An exclusion beats a pattern that names a file outright, not just a wildcard
that happens to reach it.

<Test name="An exclusion beats an exactly named file">
<TempDir>
<File path="a.md">a</File>
<File path="b.md">b</File>
<Glob include={["a.md", "b.md"]} exclude={["a.md"]} as="left" />
<AssertEquals actual={left} expected={["b.md"]} />
</TempDir>
</Test>

Several exclusions compose, and one that matches nothing removes nothing.

<Test name="Exclusions compose and an unmatched one removes nothing">
<TempDir>
<File path="keep.md">k</File>
<File path="node_modules/dep/index.md">d</File>
<File path=".git/COMMIT_EDITMSG">c</File>
<Glob
  include={["**/*"]}
  exclude={[".git/**", "**/node_modules/**", "nothing-here/**"]}
  as="sources"
/>
<AssertEquals actual={sources} expected={["keep.md"]} />
</TempDir>
</Test>

Order is lexical by code point, not the order the filesystem hands entries back
or the order the patterns were written. These files are created in reverse and
the pattern list is unsorted; the result is sorted either way.

<Test name="Results are sorted lexically, whatever the fixture did">
<TempDir>
<File path="zebra.md">z</File>
<File path="middle.md">m</File>
<File path="alpha.md">a</File>
<File path="Beta.md">B</File>
<Glob include={["zebra.md", "alpha.md", "*.md"]} as="sorted" />
<AssertEquals
  actual={sorted}
  expected={["Beta.md", "alpha.md", "middle.md", "zebra.md"]}
/>
</TempDir>
</Test>

Only files come back. `**/*` matches every path in the tree, and the
directories those files live in are not among the results.

<Test name="Directories are not results">
<TempDir>
<File path="one/two/deep.md">d</File>
<Glob include={["**/*"]} as="entries" />
<AssertEquals actual={entries} expected={["one/two/deep.md"]} />

<Glob include={["*"]} as="top" />
<AssertEquals actual={top} expected={[]} />
</TempDir>
</Test>

A leading dot is an ordinary character, so there is no hidden-file prop: `*`
matches a dot like anything else, and a pattern finds a hidden file exactly when
it says so.

<Test name="Hidden files match through ordinary pattern semantics">
<TempDir>
<File path=".hidden.md">h</File>
<File path="visible.md">v</File>
<File path=".config/settings.md">s</File>
<Glob include={["*.md"]} as="both" />
<AssertEquals actual={both} expected={[".hidden.md", "visible.md"]} />

<Glob include={[".hidden.md"]} as="named" />
<AssertEquals actual={named} expected={[".hidden.md"]} />

<Glob include={["**/*.md"]} as="tree" />
<AssertEquals
  actual={tree}
  expected={[".config/settings.md", ".hidden.md", "visible.md"]}
/>
</TempDir>
</Test>

Finding nothing is a result, not a failure: an empty array, and the document
carries on.

<Test name="Nothing matching is an empty array">
<TempDir>
<File path="a.md">a</File>
<Glob include={["*.txt"]} as="none" />
<AssertEquals actual={none} expected={[]} />

<Glob include={["**/*.md"]} exclude={["**/*"]} as="excluded" />
<AssertEquals actual={excluded} expected={[]} />
</TempDir>
</Test>

An empty directory is the same answer for the same reason.

<Test name="An empty working directory matches nothing">
<TempDir>
<Glob include={["**/*"]} as="empty" />
<AssertEquals actual={empty} expected={[]} />
</TempDir>
</Test>

Because a result is a relative path, `<Each>` can walk the listing and `<File>`
can read every entry — a fixture built in Markdown, discovered in Markdown, and
read back in Markdown, with nothing hard-coding what is there.

<Test name="Each and File consume a listing">
<TempDir>
<File path="docs/guide.md">guide</File>
<File path="docs/api/reference.md">reference</File>
<File path="README.md">readme</File>
<Glob include={["docs/**/*.md"]} as="docs" />

<Let as="contents">
<Each in={docs} let="path">
<File path={path} />
</Each>
</Let>

<AssertEquals actual={docs} expected={["docs/api/reference.md", "docs/guide.md"]} />
<AssertStringIncludes actual={contents} expected={"reference"} />
<AssertStringIncludes actual={contents} expected={"guide"} />
</TempDir>
</Test>

The directory `<Glob>` searches is the contextual one, so two `<TempDir>`
siblings see different trees — and a file the shell wrote is found on the same
terms as one `<File>` wrote.

<Test name="Glob searches the contextual directory">
<TempDir>
<File path="from-file.md">f</File>

```sh exec
echo "from the shell" > from-shell.md
```

<Glob include={["*.md"]} as="mixed" />
<AssertEquals actual={mixed} expected={["from-file.md", "from-shell.md"]} />
</TempDir>

<TempDir>
<Glob include={["*.md"]} as="separate" />
<AssertEquals actual={separate} expected={[]} />
</TempDir>
</Test>
