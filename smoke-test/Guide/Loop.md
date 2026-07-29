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

</Section>

<Test name="Loop expands its body once per iteration">
<Capture as="loopThrice"><Loop max={3}>x</Loop></Capture>
<AssertEquals actual={loopThrice} expected={"xxx"} />
</Test>

<Test name="Loop resolves its bound from an existing binding">
<Parse schema={{ type: "object", properties: { attempts: { type: "number" } }, required: ["attempts"] }} as="policy">
{ "attempts": 4 }
</Parse>
<Capture as="loopBound"><Loop max={policy.attempts}>x</Loop></Capture>
<AssertEquals actual={loopBound} expected={"xxxx"} />
</Test>

<Test name="A binding carries from one iteration to the next">
<Capture as="tally">.</Capture>
<Loop max={3}><Capture as="tally">{tally}.</Capture></Loop>
<AssertEquals actual={tally} expected={"...."} />
</Test>

<Test name="The final binding stays available after the loop">
<Loop max={2}><Capture as="lastAttempt">final</Capture></Loop>
<AssertEquals actual={lastAttempt} expected={"final"} />
</Test>

<Test name="Break ends the loop and the rest of its iteration">
<Capture as="broken"><Loop max={5}>a<Break />b</Loop></Capture>
<AssertEquals actual={broken} expected={"a"} />
</Test>

<Test name="Break inside If exits only when the condition selects it">
<Verdict as="passing" findings={[]} />
<Capture as="reviewed"><Loop max={5}>reviewed<If condition={passing.passed}><Break /></If>|</Loop></Capture>
<AssertEquals actual={reviewed} expected={"reviewed"} />
</Test>

<Test name="Break exits only the nearest loop">
<Capture as="loopNested"><Loop max={2}>(<Loop max={3}>i<Break /></Loop>)</Loop></Capture>
<AssertEquals actual={loopNested} expected={"(i)(i)"} />
</Test>

<Test name="Content after Break never runs">
<Loop max={2}>
reached
<Break />
<AssertEquals actual={"content after Break ran"} expected={"it must not run"} />
</Loop>
</Test>
