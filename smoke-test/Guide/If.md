<Section title="Conditionals">

`<If>` chooses one branch of a document and expands only that branch. The
`condition` prop selects by ordinary JavaScript truthiness — `false`, `0`, `-0`,
`0n`, `NaN`, `""`, `null`, and `undefined` take the false branch, everything
else takes the true one, including `"false"`, `[]`, and `{}` — so a document
branches on the value it already has. An optional `<Else>` block, written once
as a direct child, holds the alternative; without `<Else>` a falsy condition
renders nothing.

The unselected branch is not hidden output: it never expands, so nothing in it
imports a component, runs a code block, reaches a provider, or creates a
binding. `<If>` opens no binding scope of its own, so a `<Let>` in the
selected branch behaves like inline content and stays available after `</If>`.

</Section>

<Test name="If renders its children when the condition is true">
<Let as="ifTrue"><If condition={true}>selected</If></Let>
<AssertEquals actual={ifTrue} expected={"selected"} />
</Test>

<Test name="If without Else renders nothing when the condition is false">
<Let as="ifFalse"><If condition={false}>hidden</If></Let>
<AssertEquals actual={ifFalse} expected={""} />
</Test>

<Test name="If selects the Else branch when the condition is false">
<Let as="ifElse"><If condition={false}>then<Else>otherwise</Else></If></Let>
<AssertEquals actual={ifElse} expected={"otherwise"} />
</Test>

<Test name="If selects the leading branch when the condition is true">
<Let as="ifThen"><If condition={true}>then<Else>otherwise</Else></If></Let>
<AssertEquals actual={ifThen} expected={"then"} />
</Test>

<Test name="If resolves its condition from an existing binding">
<Verdict as="clean" findings={[]} />
<Let as="cleanReport"><If condition={clean.passed}>Approved: {clean.summary}<Else>Needs revision: {clean.summary}</Else></If></Let>
<AssertEquals actual={cleanReport} expected={"Approved: no findings"} />
</Test>

<Test name="If resolves a computed boolean expression">
<Verdict as="failing" findings={["missing test", "stale doc"]} />
<Let as="failingReport"><If condition={!failing.passed}>Needs revision: {failing.summary}<Else>Approved</Else></If></Let>
<AssertEquals actual={failingReport} expected={"Needs revision: 2 findings"} />
</Test>

<Test name="If branches on a captured string without converting it first">
<Let as="note">needs a second look</Let>
<Let as="noteReport"><If condition={note}>Note: {note}<Else>No note</Else></If></Let>
<AssertEquals actual={noteReport} expected={"Note: needs a second look"} />
</Test>

<Test name="Content around the selected branch keeps its order">
<Let as="ifOrder">before|<If condition={true}>mid<Else>alt</Else></If>|after</Let>
<AssertEquals actual={ifOrder} expected={"before|mid|after"} />
</Test>

<Test name="A Let binding from the selected branch stays available afterward">
<If condition={true}><Let as="picked">chosen</Let></If>
<AssertEquals actual={picked} expected={"chosen"} />
</Test>

<Test name="The unselected branch creates no binding">
<If condition={false}><Let as="skipped">never</Let><Else>alternative</Else></If>
<Let as="skippedProbe">[{skipped}]</Let>
<AssertEquals actual={skippedProbe} expected={"[{skipped}]"} />
</Test>

<Test name="Nested conditionals select independently">
<Let as="ifNested"><If condition={true}>outer:<If condition={false}>inner<Else>alt</Else></If>:end<Else>skipped</Else></If></Let>
<AssertEquals actual={ifNested} expected={"outer:alt:end"} />
</Test>

<Test name="The unselected branch never runs">
<If condition={true}>selected<Else>
<AssertEquals actual={"unselected branch ran"} expected={"it must not run"} />
</Else></If>
</Test>
