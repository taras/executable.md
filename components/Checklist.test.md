# Checklist

Render a checkbox for each task, preserving the supplied order and label text.
Set `done` to a boolean for every item; labels may contain ordinary Markdown.

```xmd
<Checklist items={[
  { text: "Agree on the design", done: false },
  { text: "**Implement** Checklist", done: true },
  { text: "Review the change", done: false }
]} />
```

The example renders these three lines. Capturing it compares the complete
Markdown, including the newline after each item.

<Test name="C1: mixed states preserve order and Markdown labels">
<Checklist items={[
  { text: "Agree on the design", done: false },
  { text: "**Implement** Checklist", done: true },
  { text: "Review the change", done: false }
]} as="rendered" />
<AssertEquals actual={rendered} expected={"- [ ] Agree on the design\n- [x] **Implement** Checklist\n- [ ] Review the change\n"} />
{rendered}
</Test>

An empty list renders nothing. An empty label still renders its checkbox.

<Test name="C2: an empty list renders nothing">
<Checklist items={[]} as="empty" />
<AssertEquals actual={empty} expected="" />
</Test>

<Test name="C3: an empty label keeps its checkbox">
<Checklist items={[{ text: "", done: false }]} as="emptyLabel" />
<AssertEquals actual={emptyLabel} expected={"- [ ] \n"} />
</Test>

Both the list and each completion state are required. Validation identifies the
missing field before any item renders.

<Test name="C4: required values are enforced">
<AssertThrows message="must have required property 'items'" as="missingItems"><Checklist /></AssertThrows>
<AssertEquals actual={missingItems.cause.componentName} expected="Checklist" />
<AssertEquals actual={missingItems.cause.errors[0].keyword} expected="required" />
<AssertEquals actual={missingItems.cause.errors[0].instancePath} expected="" />
<AssertEquals actual={missingItems.cause.errors[0].params.missingProperty} expected="items" />

<AssertThrows message="must have required property 'done'" as="missingDone"><Checklist items={[{ text: "Review" }]} /></AssertThrows>
<AssertEquals actual={missingDone.cause.componentName} expected="Checklist" />
<AssertEquals actual={missingDone.cause.errors[0].keyword} expected="required" />
<AssertEquals actual={missingDone.cause.errors[0].instancePath} expected="/items/0" />
<AssertEquals actual={missingDone.cause.errors[0].params.missingProperty} expected="done" />
</Test>

Values keep their declared types: a string such as `"false"` is not a boolean.

<Test name="C5: values are not coerced">
<AssertThrows message="must be array" as="wrongItems"><Checklist items="tasks" /></AssertThrows>
<AssertEquals actual={wrongItems.cause.componentName} expected="Checklist" />
<AssertEquals actual={wrongItems.cause.errors[0].keyword} expected="type" />
<AssertEquals actual={wrongItems.cause.errors[0].instancePath} expected="/items" />
<AssertEquals actual={wrongItems.cause.errors[0].params.type} expected="array" />

<AssertThrows message="must be object" as="wrongItem"><Checklist items={["task"]} /></AssertThrows>
<AssertEquals actual={wrongItem.cause.componentName} expected="Checklist" />
<AssertEquals actual={wrongItem.cause.errors[0].keyword} expected="type" />
<AssertEquals actual={wrongItem.cause.errors[0].instancePath} expected="/items/0" />
<AssertEquals actual={wrongItem.cause.errors[0].params.type} expected="object" />

<AssertThrows message="must be string" as="wrongText"><Checklist items={[{ text: 42, done: false }]} /></AssertThrows>
<AssertEquals actual={wrongText.cause.componentName} expected="Checklist" />
<AssertEquals actual={wrongText.cause.errors[0].keyword} expected="type" />
<AssertEquals actual={wrongText.cause.errors[0].instancePath} expected="/items/0/text" />
<AssertEquals actual={wrongText.cause.errors[0].params.type} expected="string" />

<AssertThrows message="must be boolean" as="wrongDone"><Checklist items={[{ text: "Review", done: "false" }]} /></AssertThrows>
<AssertEquals actual={wrongDone.cause.componentName} expected="Checklist" />
<AssertEquals actual={wrongDone.cause.errors[0].keyword} expected="type" />
<AssertEquals actual={wrongDone.cause.errors[0].instancePath} expected="/items/0/done" />
<AssertEquals actual={wrongDone.cause.errors[0].params.type} expected="boolean" />
</Test>

Unknown properties are rejected on both the Checklist invocation and each item.

<Test name="C6: root and item objects are closed">
<AssertThrows message="must NOT have additional properties" as="unknownRoot"><Checklist items={[]} extra="refused" /></AssertThrows>
<AssertEquals actual={unknownRoot.cause.componentName} expected="Checklist" />
<AssertEquals actual={unknownRoot.cause.errors[0].keyword} expected="additionalProperties" />
<AssertEquals actual={unknownRoot.cause.errors[0].instancePath} expected="" />
<AssertEquals actual={unknownRoot.cause.errors[0].params.additionalProperty} expected="extra" />

<AssertThrows message="must NOT have additional properties" as="unknownItem"><Checklist items={[{ text: "Review", done: false, extra: "refused" }]} /></AssertThrows>
<AssertEquals actual={unknownItem.cause.componentName} expected="Checklist" />
<AssertEquals actual={unknownItem.cause.errors[0].keyword} expected="additionalProperties" />
<AssertEquals actual={unknownItem.cause.errors[0].instancePath} expected="/items/0" />
<AssertEquals actual={unknownItem.cause.errors[0].params.additionalProperty} expected="extra" />
</Test>
