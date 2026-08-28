---
props: {}
---

# Tier PR — the Markdown prompt prototype

`packages/cli/src/prompt.md` asks an Agent for an executable Markdown document,
shows you what it wrote, and returns the source you approved. These rows run it
as a real child execution against a scripted Agent and scripted answers, so what
is proved is the document itself and not a stand-in for it.

Every row runs the prototype the way `xmd run` does — its own root, its own
value-root return behavior — and answers the elicitation it performs from an
`<Answers>` region, so no row stops for a person.

<Let as="request" value={"Ask for my name and write it to name.txt"} />
<Let as="syntax" value={"## Built-in structural syntax\n\n### `<Let>`\n\nBind a name for the rest of the region.\n"} />

<Test name="PR1: approving the first candidate returns it byte for byte">
<Execution
  host="run"
  target="packages/cli/src/prompt.md"
  props={{ request: request, syntax: syntax, session: "pr1" }}
  as="child"
>
<TestAgent>
<TestAgent.Scenario agent="test" session="pr1" src="./agents/approve-first.md" />
</TestAgent>
<Answers>
<Answer value={{ decision: "approve" }} />
</Answers>

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={child.result.value} expected="# Ask for a name" />
<AssertStringIncludes actual={child.result.value} expected="name.txt" />
</Execution>
</Test>

<Test name="PR2: revising sends the feedback to the same session and returns the second reply">
<Execution
  host="run"
  target="packages/cli/src/prompt.md"
  props={{ request: request, syntax: syntax, session: "pr2" }}
  as="child"
>
<TestAgent>
<TestAgent.Scenario agent="test" session="pr2" src="./agents/revise-once.md" />
</TestAgent>
<Answers>
<Answer template="{?before}FIRST-DRAFT{?after}" value={{ decision: "revise", feedback: "Too short. Write the whole thing." }} />
<Answer template="{?before}SECOND-DRAFT{?after}" value={{ decision: "approve" }} />
</Answers>

<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={child.result.value} expected="SECOND-DRAFT" />
<AssertEquals actual={child.result.value.includes("FIRST-DRAFT")} expected={false} />
</Execution>
</Test>

<Test name="PR3: revise without feedback is refused by the response schema">
<Execution
  host="run"
  target="packages/cli/src/prompt.md"
  props={{ request: request, syntax: syntax, session: "pr3" }}
  as="child"
>
<TestAgent>
<TestAgent.Scenario agent="test" session="pr3" src="./agents/revise-once.md" />
</TestAgent>
<Answers>
<Answer value={{ decision: "revise" }} />
</Answers>

<AssertEquals actual={child.result.ok} expected={false} />
<AssertStringIncludes actual={child.result.error.message} expected="feedback" />
</Execution>
</Test>

<Test name="PR4: ten revisions return no source and fail as a value root with no <Return>" timeout="60s">
<Execution
  host="run"
  target="packages/cli/src/prompt.md"
  props={{ request: request, syntax: syntax, session: "pr4" }}
  as="child"
>
<TestAgent>
<TestAgent.Scenario agent="test" session="pr4" src="./agents/always-revise.md" />
</TestAgent>
<Answers>
<Answer value={{ decision: "revise", feedback: "Still not right." }} />
</Answers>

<AssertEquals actual={child.result.ok} expected={false} />
<AssertStringIncludes
  actual={child.result.error.message}
  expected="The root document declares `returns` but produced no <Return> value."
/>
</Execution>
</Test>

<Test name="PR5: the run performs no inspection, no subprocess and no file operation">
<Execution
  host="run"
  target="packages/cli/src/prompt.md"
  props={{ request: request, syntax: syntax, session: "pr5" }}
  as="child"
>
<TestAgent>
<TestAgent.Scenario agent="test" session="pr5" src="./agents/approve-first.md" />
</TestAgent>
<Answers>
<Answer value={{ decision: "approve" }} />
</Answers>
<DiagnosticJournal />
<CollectJournal as="journal" />

<AssertEquals actual={child.result.ok} expected={true} />
<!-- The approved source names a file the prototype never writes: returning
     source is not running it. -->
<AssertEquals
  actual={journal.some((event) => event.type === "yield" && ["exec", "workspace_file", "generated_xmd"].includes(event.description.type))}
  expected={false}
/>
<AssertEquals
  actual={journal.some((event) => event.type === "yield" && event.description.type === "import_component" && ["File", "File.Delete", "Glob", "TempDir", "Execution"].includes(event.description.name))}
  expected={false}
/>
</Execution>
</Test>

<Test name="PR6: the first Agent turn carries both the request and the catalog">
<Execution
  host="run"
  target="packages/cli/src/prompt.md"
  props={{ request: request, syntax: syntax, session: "pr6" }}
  as="child"
>
<TestAgent>
<TestAgent.Scenario agent="test" session="pr6" src="./agents/approve-first.md" />
</TestAgent>
<Answers>
<Answer value={{ decision: "approve" }} />
</Answers>
<DiagnosticJournal />
<CollectJournal as="journal" />

<AssertEquals actual={child.result.ok} expected={true} />
<Let as="firstPrompt" value={journal.find((event) => event.type === "yield" && event.description.type === "agent_prompt")} />
<AssertStringIncludes actual={firstPrompt.description.input} expected={request} />
<AssertStringIncludes actual={firstPrompt.description.input} expected="Bind a name for the rest of the region." />
</Execution>
</Test>

<Test name="PR7: a fenced reply is returned unchanged">
<Execution
  host="run"
  target="packages/cli/src/prompt.md"
  props={{ request: request, syntax: syntax, session: "pr7" }}
  as="child"
>
<TestAgent>
<TestAgent.Scenario agent="test" session="pr7" src="./agents/fenced-reply.md" />
</TestAgent>
<Answers>
<Answer value={{ decision: "approve" }} />
</Answers>

<AssertEquals actual={child.result.ok} expected={true} />
<!-- The prototype extracts nothing, so the fence the Agent wrote survives. -->
<AssertStringIncludes actual={child.result.value} expected="````md" />
<AssertStringIncludes actual={child.result.value} expected="# Fenced on purpose" />
</Execution>
</Test>
