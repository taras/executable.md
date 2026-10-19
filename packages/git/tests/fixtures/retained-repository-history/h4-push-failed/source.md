<Repository name="project" url="/private/tmp/xmd-retained-history/h4-push-failed/origin.git">
  <Git.Switch branch="review/divergent" />
  <File path="notes.md">ready</File>
  <Git.Add paths="notes.md" />
  <Git.Commit message="Prepare notes" as="commit" />
  <Git.Push />
  <Elicit schema={{ type: "object", properties: { choice: { enum: ["continue"] } },
    required: ["choice"], additionalProperties: false }} as="answer">
The branch was published. Continue?
  </Elicit>
  <File path="after.md">continued</File>
</Repository>
