# If

`<If>` chooses one branch of a document and expands only that branch. It is a
directive the expansion engine handles itself, so there is no `If.md` to import
and nothing to install before using it.

A true condition renders the content it guards.

<Test name="A true condition renders its children">
<Let as="rendered"><If condition={true}>selected</If></Let>
<AssertEquals actual={rendered} expected={"selected"} />
</Test>

A false condition with nothing else to say renders nothing at all — not an
empty region, not a placeholder.

<Test name="A false condition without Else renders nothing">
<Let as="empty"><If condition={false}>hidden</If></Let>
<AssertEquals actual={empty} expected={""} />
</Test>

`<Else>` supplies the alternative. Whichever branch the condition selects, the
other one contributes nothing to the output.

<Test name="A false condition selects the Else branch">
<Let as="otherwise"><If condition={false}>then<Else>otherwise</Else></If></Let>
<AssertEquals actual={otherwise} expected={"otherwise"} />
</Test>

<Test name="A true condition selects the leading branch">
<Let as="then"><If condition={true}>then<Else>otherwise</Else></If></Let>
<AssertEquals actual={then} expected={"then"} />
</Test>

The condition is an ordinary expression, so it reads whatever the document has
already bound. Here `<Parse>` turns a JSON answer into a value, and `<If>`
branches on one of its fields.

<Test name="The condition reads a binding the document already made">
<Parse schema={{ type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] }} as="verdict">
{ "passed": true }
</Parse>
<Let as="report"><If condition={verdict.passed}>approved<Else>needs revision</Else></If></Let>
<AssertEquals actual={report} expected={"approved"} />
</Test>

<Test name="The condition may compute a boolean from that binding">
<Parse schema={{ type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] }} as="failing">
{ "passed": false }
</Parse>
<Let as="failingReport"><If condition={!failing.passed}>needs revision<Else>approved</Else></If></Let>
<AssertEquals actual={failingReport} expected={"needs revision"} />
</Test>

The selected branch is spliced in where the directive was written, so content
around it keeps its order.

<Test name="Content around the selected branch keeps its order">
<Let as="ordered">before|<If condition={true}>mid<Else>alt</Else></If>|after</Let>
<AssertEquals actual={ordered} expected={"before|mid|after"} />
</Test>

`<If>` opens no scope of its own. A binding the selected branch creates behaves
like one written inline, so it is still readable after `</If>`.

<Test name="A Let binding from the selected branch survives the block">
<If condition={true}><Let as="picked">chosen</Let></If>
<AssertEquals actual={picked} expected={"chosen"} />
</Test>

The branch that is not selected never expands, so it binds nothing. A reference
to a name it would have created stays unresolved, exactly as a reference to a
name no one ever wrote.

<Test name="The unselected branch creates no binding">
<If condition={false}><Let as="skipped">never</Let><Else>alternative</Else></If>
<Let as="probe">[{skipped}]</Let>
<AssertEquals actual={probe} expected={"[{skipped}]"} />
</Test>

Conditionals nest, and each one selects on its own.

<Test name="Nested conditionals select independently">
<Let as="nested"><If condition={true}>outer:<If condition={false}>inner<Else>alt</Else></If>:end<Else>skipped</Else></If></Let>
<AssertEquals actual={nested} expected={"outer:alt:end"} />
</Test>

"Never expands" is stronger than "renders nothing". An assertion placed in the
unselected branch would fail this document if it ran — the test passes only
because that branch is never reached.

<Test name="The unselected branch never runs">
<If condition={true}>selected<Else>
<AssertEquals actual={"the unselected branch ran"} expected={"it must never run"} />
</Else></If>
</Test>
