# Loop

`<Loop>` repeats a region of a document a bounded number of times. It is a
directive the expansion engine handles itself, so there is no `Loop.md` to
import and nothing to install before using it.

`max` is required, and it is the whole bound: the body expands in document
order at most that many times.

<Test name="The body expands exactly max times">
<Capture as="thrice"><Loop max={3}>x</Loop></Capture>
<AssertEquals actual={thrice} expected={"xxx"} />
</Test>

<Test name="A bound of one expands the body once">
<Capture as="once"><Loop max={1}>x</Loop></Capture>
<AssertEquals actual={once} expected={"x"} />
</Test>

Reaching `max` completes the loop normally. Exhaustion is not a failure — the
document around the loop decides what an exhausted bound means, and content
after `</Loop>` renders as it would anywhere else.

<Test name="Reaching max completes normally and the document continues">
<Capture as="ordered">before|<Loop max={2}>x</Loop>|after</Capture>
<AssertEquals actual={ordered} expected={"before|xx|after"} />
</Test>

The bound is an ordinary expression, so it reads whatever the document has
already bound.

<Test name="The bound reads a binding the document already made">
<Parse schema={{ type: "object", properties: { attempts: { type: "number" } }, required: ["attempts"] }} as="policy">
{ "attempts": 4 }
</Parse>
<Capture as="bounded"><Loop max={policy.attempts}>x</Loop></Capture>
<AssertEquals actual={bounded} expected={"xxxx"} />
</Test>

`<Loop>` opens no binding scope. Every iteration expands in the enclosing
environment, so an iteration reads what earlier ones bound.

<Test name="An iteration reads what an earlier one bound">
<Capture as="tally">.</Capture>
<Loop max={3}><Capture as="tally">{tally}.</Capture></Loop>
<AssertEquals actual={tally} expected={"...."} />
</Test>

For the same reason the final values stay readable after the loop, which is how
a document acts on what the repetition produced.

<Test name="The final binding is readable after the loop">
<Loop max={2}><Capture as="attempt">last attempt</Capture></Loop>
<AssertEquals actual={attempt} expected={"last attempt"} />
</Test>

Loops nest, and the inner loop runs again for every iteration of the outer one.

<Test name="Nested loops multiply">
<Capture as="nested"><Loop max={2}>(<Loop max={3}>i</Loop>)</Loop></Capture>
<AssertEquals actual={nested} expected={"(iii)(iii)"} />
</Test>

`name` is optional and diagnostic only. It labels the loop in the errors the
loop reports and changes nothing about what the loop renders or binds.

<Test name="A name does not change what the loop renders">
<Capture as="named"><Loop name="planning" max={2}>y</Loop></Capture>
<AssertEquals actual={named} expected={"yy"} />
</Test>

<Test name="A name is not published as a binding">
<Capture as="probe"><Loop name="planning" max={1}>({name})({planning})</Loop></Capture>
<AssertEquals actual={probe} expected={"({name})({planning})"} />
</Test>
