# A document with two sections

<Parse schema={{ type: "object", required: ["token"], properties: { token: { type: "string" } } }} as="preamble">
{"token": "PREAMBLE_TOKEN"}
</Parse>

The preamble establishes a value. Selecting a target executes this content and
the target's own subtree, so a test below that reads `preamble.token` passes
only if the preamble was actually retained rather than projected away.

## Selected

<Test name="the selected section consumes preamble state">
<AssertEquals actual={preamble.token} expected={"PREAMBLE_TOKEN"} />
</Test>

## Untouched

This section fails whenever it runs, and prints a marker so a run that executed
it cannot look like a run that did not.

<Test name="the untouched section must not run">
SIBLING_MARKER
<Assert expr={false} />
</Test>
