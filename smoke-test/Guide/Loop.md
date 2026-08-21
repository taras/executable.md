<Section title="Bounded repetition">

`<Loop>` expands a region of a document more than once, under a bound the
document states. `max` is required and must be a positive integer — there is no
unbounded form. Reaching `max` completes the loop normally: exhaustion is not a
failure, and whether it means the work succeeded is a decision the surrounding
document writes as an ordinary `<If>`.

`<Loop>` opens no binding scope. Each iteration expands in the enclosing
environment, so it reads what earlier iterations bound and the final values
stay available after `</Loop>`. `<Break />` ends the loop it is written in: the
rest of that iteration never expands, and the iterations that were left never
run.

Which loop a `<Break>` means is decided by where the author wrote it. Content
handed to a component is the caller's text, so a `<Break>` there ends the
caller's loop. A `<Break>` a component writes in its own body belongs to a loop
in that body — a loop the caller wrote is not the component's to end, and a
component-written `<Break>` with no loop of its own is stray.

</Section>

<Test name="Loop expands its body once per iteration">
<Let as="loopThrice"><Loop max={3}>x</Loop></Let>
<AssertEquals actual={loopThrice} expected={"xxx"} />
</Test>

<Test name="Loop resolves its bound from an existing binding">
<Parse schema={{ type: "object", properties: { attempts: { type: "number" } }, required: ["attempts"] }} as="policy">
{ "attempts": 4 }
</Parse>
<Let as="loopBound"><Loop max={policy.attempts}>x</Loop></Let>
<AssertEquals actual={loopBound} expected={"xxxx"} />
</Test>

<Test name="A binding carries from one iteration to the next">
<Let as="tally">.</Let>
<Loop max={3}><Let as="tally">{tally}.</Let></Loop>
<AssertEquals actual={tally} expected={"...."} />
</Test>

<Test name="The final binding stays available after the loop">
<Loop max={2}><Let as="lastAttempt">final</Let></Loop>
<AssertEquals actual={lastAttempt} expected={"final"} />
</Test>

<Test name="Break ends the loop and the rest of its iteration">
<Let as="broken"><Loop max={5}>a<Break />b</Loop></Let>
<AssertEquals actual={broken} expected={"a"} />
</Test>

<Test name="Break inside If exits only when the condition selects it">
<Verdict as="passing" findings={[]} />
<Let as="reviewed"><Loop max={5}>reviewed<If condition={passing.passed}><Break /></If>|</Loop></Let>
<AssertEquals actual={reviewed} expected={"reviewed"} />
</Test>

<Test name="Break exits only the nearest loop">
<Let as="loopNested"><Loop max={2}>(<Loop max={3}>i<Break /></Loop>)</Loop></Let>
<AssertEquals actual={loopNested} expected={"(i)(i)"} />
</Test>

<Test name="Content after Break never runs">
<Loop max={2}>
reached
<Break />
<AssertEquals actual={"content after Break ran"} expected={"it must not run"} />
</Loop>
</Test>

<Test name="A Break the caller hands to a component exits the caller's loop">
<Let as="projectedBreak"><Loop max={3}>kept<Section title="Held"><Break /></Section>dropped</Loop></Let>
<AssertStringIncludes actual={projectedBreak} expected={"kept"} />
<AssertNotMatch actual={projectedBreak} expected={/dropped/} />
</Test>

<Test name="A Break a component writes belongs to the component's own loop">
<Let as="ownBreak"><Loop max={2}>kept<OwnLoop />tail</Loop></Let>
<AssertStringIncludes actual={ownBreak} expected={"tail"} />
<AssertNotMatch actual={ownBreak} expected={/xx/} />
</Test>
