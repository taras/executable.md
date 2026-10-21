<IssueTracker url="https://github.com/octo/project">
<Issue title="Filed" as="filed">a described issue</Issue>
</IssueTracker>
<Elicit schema={{ type: "object", properties: { choice: { enum: ["continue"] } },
  required: ["choice"], additionalProperties: false }} as="answer">
Continue?
</Elicit>
<File path="after.md">continued</File>
