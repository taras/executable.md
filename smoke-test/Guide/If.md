<Section title="Conditionals">

`<If>` chooses one branch of a document and expands only that branch. The
`condition` prop is a boolean — there is no truthy or falsy coercion — and an
optional `<Else>` block, written once as a direct child, holds the alternative.
Without `<Else>` a false condition renders nothing.

The unselected branch is not hidden output: it never expands, so nothing in it
imports a component, runs a code block, reaches a provider, or creates a
binding. `<If>` opens no binding scope of its own, so a `<Capture>` in the
selected branch behaves like inline content and stays available after `</If>`.

</Section>

<Test name="If renders its children when the condition is true">
<Capture as="ifTrue"><If condition={true}>selected</If></Capture>
<AssertEquals actual={ifTrue} expected={"selected"} />
</Test>

<Test name="If without Else renders nothing when the condition is false">
<Capture as="ifFalse"><If condition={false}>hidden</If></Capture>
<AssertEquals actual={ifFalse} expected={""} />
</Test>

<Test name="If selects the Else branch when the condition is false">
<Capture as="ifElse"><If condition={false}>then<Else>otherwise</Else></If></Capture>
<AssertEquals actual={ifElse} expected={"otherwise"} />
</Test>

<Test name="If selects the leading branch when the condition is true">
<Capture as="ifThen"><If condition={true}>then<Else>otherwise</Else></If></Capture>
<AssertEquals actual={ifThen} expected={"then"} />
</Test>

<Test name="If resolves its condition from an existing binding">
<Verdict as="clean" findings={[]} />
<Capture as="cleanReport"><If condition={clean.passed}>Approved: {clean.summary}<Else>Needs revision: {clean.summary}</Else></If></Capture>
<AssertEquals actual={cleanReport} expected={"Approved: no findings"} />
</Test>

<Test name="If resolves a computed boolean expression">
<Verdict as="failing" findings={["missing test", "stale doc"]} />
<Capture as="failingReport"><If condition={!failing.passed}>Needs revision: {failing.summary}<Else>Approved</Else></If></Capture>
<AssertEquals actual={failingReport} expected={"Needs revision: 2 findings"} />
</Test>

<Test name="Content around the selected branch keeps its order">
<Capture as="ifOrder">before|<If condition={true}>mid<Else>alt</Else></If>|after</Capture>
<AssertEquals actual={ifOrder} expected={"before|mid|after"} />
</Test>

<Test name="A capture from the selected branch stays available afterward">
<If condition={true}><Capture as="picked">chosen</Capture></If>
<AssertEquals actual={picked} expected={"chosen"} />
</Test>

<Test name="The unselected branch creates no binding">
<If condition={false}><Capture as="skipped">never</Capture><Else>alternative</Else></If>
<Capture as="skippedProbe">[{skipped}]</Capture>
<AssertEquals actual={skippedProbe} expected={"[{skipped}]"} />
</Test>

<Test name="Nested conditionals select independently">
<Capture as="ifNested"><If condition={true}>outer:<If condition={false}>inner<Else>alt</Else></If>:end<Else>skipped</Else></If></Capture>
<AssertEquals actual={ifNested} expected={"outer:alt:end"} />
</Test>

<Test name="The unselected branch never runs">
<If condition={true}>selected<Else>
<AssertEquals actual={"unselected branch ran"} expected={"it must not run"} />
</Else></If>
</Test>
