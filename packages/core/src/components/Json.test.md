# Json

`<Json>` renders a structured value as JSON text, right where it is written.
`<Let>` introduces the value, this renders it, and `<Parse>` turns text back
into a validated value — so a prompt or a file can carry a value the document
already holds without an eval block building the text by hand.

An object renders pretty-printed with two spaces per level, and the text it
produces parses back to the value it was given.

<Test name="An object renders two-space JSON that parses back">
<Let as="source" value={{ name: "widget", version: 2, tags: ["a", "b"] }} />
<Let as="expected" select="code[lang=json]">
```json
{
  "name": "widget",
  "version": 2,
  "tags": [
    "a",
    "b"
  ]
}
```
</Let>
<Let as="rendered"><Json value={source} /></Let>
<AssertEquals actual={rendered} expected={expected} />
<Parse schema={{ type: "object" }} as="roundTrip"><Json value={source} /></Parse>
<AssertEquals actual={roundTrip} expected={source} />
</Test>

Nesting is the same rule applied again: each level adds two more spaces, and
objects and arrays nest inside one another freely.

<Test name="Nested objects and arrays indent one level deeper">
<Let as="expected" select="code[lang=json]">
```json
{
  "matrix": [
    [
      1,
      2
    ]
  ],
  "meta": {
    "deep": {
      "ok": true
    }
  }
}
```
</Let>
<Let as="rendered"><Json value={{ matrix: [[1, 2]], meta: { deep: { ok: true } } }} /></Let>
<AssertEquals actual={rendered} expected={expected} />
</Test>

A value does not have to be an object. An array, a string, a number, a boolean
and `null` each render as JSON writes them.

<Test name="An array renders as an array">
<Let as="expected" select="code[lang=json]">
```json
[
  "alpha",
  "beta"
]
```
</Let>
<Let as="rendered"><Json value={["alpha", "beta"]} /></Let>
<AssertEquals actual={rendered} expected={expected} />
</Test>

<Test name="A string renders quoted">
<Let as="rendered"><Json value={"widget"} /></Let>
<AssertEquals actual={rendered} expected={"\"widget\""} />
</Test>

<Test name="A number renders unquoted">
<Let as="rendered"><Json value={42} /></Let>
<AssertEquals actual={rendered} expected={"42"} />
</Test>

<Test name="A boolean renders as true or false">
<Let as="rendered"><Json value={true} /></Let>
<AssertEquals actual={rendered} expected={"true"} />
</Test>

<Test name="null renders as null">
<Let as="rendered"><Json value={null} /></Let>
<AssertEquals actual={rendered} expected={"null"} />
</Test>

Inside a container, JavaScript values JSON has no word for follow JSON's own
rules rather than any rule this component invents: an object property holding
`undefined`, a function or a symbol is left out, the matching array entry
becomes `null`, and `Infinity` and `NaN` become `null` too.

<Test name="Container members follow native JSON rules">
<Let as="containers" value={{ kept: 1, dropped: undefined, run: () => {}, tag: Symbol("tag"), huge: Infinity, unknown: NaN, list: [undefined, () => {}, Infinity] }} />
<Let as="expected" select="code[lang=json]">
```json
{
  "kept": 1,
  "huge": null,
  "unknown": null,
  "list": [
    null,
    null,
    null
  ]
}
```
</Let>
<Let as="rendered"><Json value={containers} /></Let>
<AssertEquals actual={rendered} expected={expected} />
</Test>

The text lands exactly where the element was written, and nothing is added
around it — no trailing newline, and no separator. A file that must end in a
newline gets one from the document that writes it, not from here.

<Test name="Rendering adds no newline and no separator">
<Let as="rendered">before<Json value={{ ok: true }} />after</Let>
<AssertEquals actual={rendered} expected={"before{\n  \"ok\": true\n}after"} />
</Test>

Ordinary interpolation is unchanged. Writing `{binding}` still coerces the value
to a string the way it always has, so choosing JSON stays something the document
says out loud.

<Test name="Interpolation still coerces rather than serializing">
<Let as="source" value={{ name: "widget" }} />
<Let as="interpolated">{source}</Let>
<AssertEquals actual={interpolated} expected={"[object Object]"} />
<Let as="rendered"><Json value={source} /></Let>
<AssertNotEquals actual={rendered} expected={interpolated} />
</Test>
