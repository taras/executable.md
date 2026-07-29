# Break

`<Break>` ends the loop it is written in. It is self-closing, takes no props and
no content, and is only meaningful inside a `<Loop>` — a document that reaches
its bound and one that breaks out early are the two ways a bounded repetition
finishes.

A `<Break>` in the body stops the remaining iterations, so a bound of five can
run exactly once.

<Test name="An immediate Break runs the body once">
<Capture as="once"><Loop max={5}>a<Break /></Loop></Capture>
<AssertEquals actual={once} expected={"a"} />
</Test>

It also stops the rest of the iteration it appears in. Everything before it
stands; nothing after it renders.

<Test name="Content after Break does not render">
<Capture as="partial"><Loop max={2}>before<Break />after</Loop></Capture>
<AssertEquals actual={partial} expected={"before"} />
</Test>

That is the useful shape: a condition the document has already computed decides
whether this iteration was the last one.

<Test name="Break inside If exits the loop">
<Parse schema={{ type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] }} as="verdict">
{ "passed": true }
</Parse>
<Capture as="reviewed"><Loop max={5}>reviewed<If condition={verdict.passed}><Break /></If>|</Loop></Capture>
<AssertEquals actual={reviewed} expected={"reviewed"} />
</Test>

<Test name="An unselected Break leaves the loop running">
<Parse schema={{ type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] }} as="failing">
{ "passed": false }
</Parse>
<Capture as="repeated"><Loop max={3}>a<If condition={failing.passed}><Break /></If></Loop></Capture>
<AssertEquals actual={repeated} expected={"aaa"} />
</Test>

Bindings made before the `<Break>` survive it, so the loop's last attempt is
still what the rest of the document reads.

<Test name="A binding made before the Break survives the loop">
<Loop max={5}><Capture as="picked">chosen</Capture><Break /></Loop>
<AssertEquals actual={picked} expected={"chosen"} />
</Test>

A `<Break>` exits the nearest loop only. An inner loop that breaks leaves the
outer one running.

<Test name="Break exits only the nearest loop">
<Capture as="nested"><Loop max={2}>(<Loop max={3}>i<Break /></Loop>)</Loop></Capture>
<AssertEquals actual={nested} expected={"(i)(i)"} />
</Test>

"Does not render" is weaker than what actually happens: content after a
`<Break>` never expands at all. An assertion placed there would fail this
document if it ran — the test passes only because that content is never
reached.

<Test name="Content after Break never runs">
<Loop max={2}>
reached
<Break />
<AssertEquals actual={"the content after Break ran"} expected={"it must never run"} />
</Loop>
</Test>
