<Section title="Iteration">

The `<Each>` directive renders its body once per element of an array. The
`in` prop is the array to iterate, and `let` names the per-item binding —
a string literal that is visible to `{...}` interpolation and to eval blocks
in the body. Each iteration renders in its own block scope, so the binding
never leaks to siblings, the parent, or later iterations. An empty array
renders nothing, and `as` captures the whole rendered loop into a binding
instead of emitting it inline.

`<Each>` keeps iteration declarative: the body is Markdown, not a
JavaScript `.map().join()`, so row rendering and presentation stay out of
eval blocks. Eval blocks still compute the array being iterated — `<Each>`
moves presentation out of JavaScript, not data shaping.

</Section>

<Test name="Each renders its body once per item">
```js eval
const rows = [{ label: "alpha", score: 1 }, { label: "beta", score: 2 }];
```
<Capture as="eachRows"><Each in={rows} let="row">- {row.label}: {row.score}
</Each></Capture>
<AssertEquals actual={eachRows} expected={"- alpha: 1\n- beta: 2"} />
</Test>

<Test name="Each over an empty array renders nothing">
```js eval
const empty = [];
```
<Capture as="eachEmpty"><Each in={empty} let="row">- {row.label}
</Each></Capture>
<AssertEquals actual={eachEmpty} expected={""} />
</Test>

<Test name="Each with as captures the whole rendered loop">
```js eval
const cells = [{ v: "x" }, { v: "y" }, { v: "z" }];
```
<Each in={cells} let="cell" as="joined">{cell.v} </Each>
<AssertEquals actual={joined} expected={"x y z "} />
</Test>

<Test name="Each item binding is visible to body eval blocks">
```js eval
const points = [{ n: 2 }, { n: 3 }];
```
<Capture as="eachEval"><Each in={points} let="point">
```js eval
output("squared:" + (point.n * point.n));
```
</Each></Capture>
<AssertEquals actual={eachEval} expected={"\nsquared:4\nsquared:9"} />
</Test>
