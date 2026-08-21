# Parse

`<Parse>` turns content into a value the rest of the document can use. It takes
a schema and a name, binds exactly what the content said, and renders nothing.
Nothing here calls an agent — the content is written in the document, so every
scenario below is about parsing alone.

A schema can be text the document captured. That is the usual shape when the
schema itself lives in the document, in a fence a reader can see.

<Test name="A captured JSON schema validates captured content">
<Let as="schemaText" select="code[lang=json]">
```json
{
  "type": "object",
  "properties": { "passed": { "type": "boolean" }, "score": { "type": "number" } },
  "required": ["passed", "score"],
  "additionalProperties": false
}
```
</Let>
<Parse schema={schemaText} as="verdict">
{ "passed": true, "score": 9 }
</Parse>
<AssertEquals actual={verdict} expected={{ passed: true, score: 9 }} />
</Test>

The same schema can be given as a structured value instead. Both forms compile
through the same draft-07 compiler, so they accept and reject the same content.

<Test name="A structured schema behaves identically to its text form">
<Let as="schemaText" select="code[lang=json]">
```json
{ "type": "object", "properties": { "passed": { "type": "boolean" } }, "required": ["passed"] }
```
</Let>
<Parse schema={schemaText} as="fromText">
{ "passed": true }
</Parse>
<Parse schema={{ type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] }} as="fromValue">
{ "passed": true }
</Parse>
<AssertEquals actual={fromText} expected={fromValue} />
</Test>

Any JSON value can be the result, not only an object. An array, a number, a
string, a boolean, and `null` each bind as themselves.

<Test name="An array binds as an array">
<Parse schema={{ type: "array", items: { type: "string" } }} as="tags">
["alpha", "beta"]
</Parse>
<AssertEquals actual={tags} expected={["alpha", "beta"]} />
</Test>

<Test name="A number binds as a number">
<Parse schema={{ type: "number" }} as="count">
42
</Parse>
<AssertEquals actual={count} expected={42} />
</Test>

<Test name="A string binds as a string">
<Parse schema={{ type: "string" }} as="name">
"widget"
</Parse>
<AssertEquals actual={name} expected={"widget"} />
</Test>

<Test name="A boolean binds as a boolean">
<Parse schema={{ type: "boolean" }} as="enabled">
false
</Parse>
<AssertEquals actual={enabled} expected={false} />
</Test>

<Test name="Null binds as null">
<Parse schema={{ type: "null" }} as="nothing">
null
</Parse>
<AssertEquals actual={nothing} expected={null} />
</Test>

A schema may refer to its own definitions. References contained within the
supplied schema resolve; external file and HTTP(S) references do not yet.

<Test name="A local fragment reference resolves">
<Let as="refSchema" select="code[lang=json]">
```json
{
  "definitions": {
    "finding": {
      "type": "object",
      "properties": { "file": { "type": "string" } },
      "required": ["file"]
    }
  },
  "type": "array",
  "items": { "$ref": "#/definitions/finding" }
}
```
</Let>
<Parse schema={refSchema} as="findings">
[{ "file": "a.ts" }, { "file": "b.ts" }]
</Parse>
<AssertEquals actual={findings} expected={[{ file: "a.ts" }, { file: "b.ts" }]} />
</Test>

Validation judges the content; it never edits it. A declared `default` is not
inserted for a property the content omitted.

<Test name="A declared default is not inserted">
<Parse schema={{ type: "object", properties: { level: { type: "string", default: "info" } } }} as="record">
{ }
</Parse>
<AssertEquals actual={record} expected={{}} />
</Test>

A value keeps the type it was written with. A string that looks like a number
stays a string, and the schema that asked for a string is what accepts it.

<Test name="A type is not coerced">
<Parse schema={{ type: "object", properties: { port: { type: "string" } } }} as="config">
{ "port": "8080" }
</Parse>
<AssertEquals actual={config} expected={{ port: "8080" }} />
</Test>

A property the schema does not declare survives, as long as the schema allows
it.

<Test name="An undeclared property is not removed">
<Parse schema={{ type: "object", properties: { id: { type: "string" } }, additionalProperties: true }} as="row">
{ "id": "1", "note": "kept" }
</Parse>
<AssertEquals actual={row} expected={{ id: "1", note: "kept" }} />
</Test>

Binding a value is all it does. `<Parse>` contributes nothing to the rendered
document.

<Test name="Parse renders nothing">
<Let as="rendered"><Parse schema={{ type: "number" }} as="ignored">1</Parse></Let>
<AssertEquals actual={rendered} expected={""} />
</Test>
