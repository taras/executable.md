# Create a project README

<Elicit schema={{ type: "object", properties: { project: { type: "string", title: "Project name", description: "Name your project.", minLength: 1 }, summary: { type: "string", title: "One-sentence description", description: "Describe its purpose.", minLength: 1 } }, required: ["project", "summary"], additionalProperties: false }} as="answers">Enter the project details.</Elicit>

Proposed README.md:

# The project

<Json value={answers} />

<Elicit schema={{ type: "object", properties: { decision: { type: "string", title: "Create README.md?", enum: ["Approve", "Decline"] } }, required: ["decision"], additionalProperties: false }} as="confirmation">Review this README.

# The project

<Json value={answers} />

</Elicit>

<Json value={confirmation} as="decided" />
<Json value={{ decision: "Approve" }} as="approval" />
<Switch value={decided}>
<Case value={approval}>
<File path="README.md"># The project

<Json value={answers} />
</File>
README.md was created.
</Case>
<Case default>
No file was created.
</Case>
</Switch>
