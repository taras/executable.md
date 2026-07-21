<Section title="Typed Inputs">

A component's `inputs` is a JSON Schema. Arrays declare their element type
via `items`, object arrays declare each element's shape, and nested `default`
values fill in recursively. Invalid data is rejected with a precise message,
and `<AssertThrows>` turns that rejection into a passing test.

</Section>

<Test name="A scalar array of strings renders">
<Capture as="list"><TypedList files={["a.ts", "b.ts"]} /></Capture>
<AssertEquals actual={list} expected={"\na.ts, b.ts"} />
</Test>

<Test name="An object array fills a nested default">
<Capture as="rows"><TypedRows rows={[{ symbol: "x" }, { symbol: "y", line: 5 }]} /></Capture>
<AssertEquals actual={rows} expected={"\nx@0:info, y@5:info"} />
</Test>

<Test name="A wrong array element type is rejected">
<AssertThrows message={/must be string/}><TypedList files={[1, 2, 3]} /></AssertThrows>
</Test>

<Test name="A missing required object key is rejected, exposing the cause">
<AssertThrows message={/must have required property/} as="thrown"><TypedRows rows={[{ line: 1 }]} /></AssertThrows>
<AssertEquals actual={thrown.cause.componentName} expected={"TypedRows"} />
<AssertEquals actual={thrown.cause.errors[0].keyword} expected={"required"} />
<AssertEquals actual={thrown.cause.errors[0].params.missingProperty} expected={"symbol"} />
</Test>

<Test name="An undeclared object property is rejected">
<AssertThrows message={/must NOT have additional properties/}><TypedRows rows={[{ symbol: "x", extra: 1 }]} /></AssertThrows>
</Test>

<Test name="A wrong-typed object field is rejected">
<AssertThrows message={/must be string/}><TypedRows rows={[{ symbol: 123 }]} /></AssertThrows>
</Test>

<Test name="An invalid nested enum value is rejected">
<AssertThrows message={/must be equal to one of the allowed values/}><TypedRows rows={[{ symbol: "x", level: "nope" }]} /></AssertThrows>
</Test>
