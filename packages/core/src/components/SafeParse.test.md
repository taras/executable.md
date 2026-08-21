# SafeParse

`<SafeParse>` answers the same question as `<Parse>` without ending the run when
the answer is no. It binds a result the document can read: either the validated
value, or the text that failed together with what was wrong with it. That is
what lets a repair loop live in Markdown instead of inside the component.

Content that parses and validates binds the success shape.

<Test name="Valid content binds ok with the validated value">
<Let as="schemaText" select="code[lang=json]">
```json
{
  "type": "object",
  "properties": { "passed": { "type": "boolean" } },
  "required": ["passed"],
  "additionalProperties": false
}
```
</Let>
<SafeParse schema={schemaText} as="result">
{ "passed": true }
</SafeParse>
<AssertEquals actual={result} expected={{ ok: true, value: { passed: true } }} />
</Test>

Content that is not JSON at all binds the failure shape. The failure is
described as one issue in the same normalized form a schema failure uses,
distinguished by its `keyword`, so a document reads both kinds the same way.

<Test name="Malformed JSON is reported as a parse issue">
<SafeParse schema={{ type: "object" }} as="result">Sorry, I cannot do that.</SafeParse>
<AssertFalse expr={result.ok} />
<AssertEquals actual={result.errors.length} expected={1} />
<Each in={result.errors} let="issue" as="keywords">{issue.keyword}</Each>
<AssertEquals actual={keywords} expected={"parse"} />
</Test>

The text that failed is kept exactly as the content produced it, so a corrective
prompt can quote what was actually said.

<Test name="A failed result keeps the original input">
<Let as="raw">Sorry, I cannot do that.</Let>
<SafeParse schema={{ type: "object" }} as="result">Sorry, I cannot do that.</SafeParse>
<AssertEquals actual={result.input} expected={raw} />
</Test>

JSON that parses but does not satisfy the schema fails the same way, and every
problem is reported rather than only the first.

<Test name="A schema failure reports every issue">
<SafeParse schema={{ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] }} as="result">
{ }
</SafeParse>
<AssertFalse expr={result.ok} />
<AssertEquals actual={result.errors.length} expected={2} />
<Each in={result.errors} let="issue" as="keywords">{issue.keyword} </Each>
<AssertStringIncludes actual={keywords} expected={"required"} />
</Test>

Each issue carries the location it applies to, which is what a repair prompt
renders.

<Test name="An issue names where it applies">
<SafeParse schema={{ type: "object", properties: { port: { type: "number" } } }} as="result">
{ "port": "8080" }
</SafeParse>
<AssertFalse expr={result.ok} />
<Each in={result.errors} let="issue" as="paths">{issue.instancePath}</Each>
<AssertEquals actual={paths} expected={"/port"} />
</Test>

Like `<Parse>`, it validates without editing. A successful result holds exactly
what the content said — no default inserted, no type coerced, no property
dropped.

<Test name="A successful result is not transformed">
<SafeParse schema={{ type: "object", properties: { level: { type: "string", default: "info" }, port: { type: "string" } }, additionalProperties: true }} as="result">
{ "port": "8080", "note": "kept" }
</SafeParse>
<AssertEquals actual={result} expected={{ ok: true, value: { port: "8080", note: "kept" } }} />
</Test>

It renders nothing either. The result is the whole of its contribution.

<Test name="SafeParse renders nothing">
<Let as="rendered"><SafeParse schema={{ type: "number" }} as="ignored">1</SafeParse></Let>
<AssertEquals actual={rendered} expected={""} />
</Test>
