# Planning document logic

The stages in this directory are the shipped-syntax part of the workflow, and
this document is the proof that they execute
([#290](https://github.com/taras/executable.md/issues/290)). It uses stub Agents
and document-supplied answers in one process and one working directory. Nothing
here needs WorkflowRun persistence, a Repository or Worktree, Git, a forge, or a
Worker Shell.

One thing has to be supplied for `Discovery` and `Planning` to run at all:
`<Agent.AddDir>` is #302's and does not exist. `Agent/AddDir.md` beside this
document is a no-op stub, and it resolves only for documents in *this*
directory — registration and repository resolution are both scope-local, so the
name still resolves to nothing everywhere the workflow's own inventory says it
does.

## Instruction files reach the prompt exactly

`InstructionFiles` renders the exact path and content of every file it is
given, and `Discovery` interpolates that rendering into its prompt. The scenario
constrains the literal instruction text, so a prompt that dropped or summarized
it fails rather than matching.

<Test name="exact instruction paths and contents reach the planner prompt">

<InstructionFiles
  paths={["workflows/adversarial-implementation/tests/fixtures/AGENTS.md", "workflows/adversarial-implementation/tests/fixtures/nested/AGENTS.md"]}
  as="instructions"
/>

<AssertStringIncludes actual={instructions} expected="tests/fixtures/AGENTS.md" />
<AssertStringIncludes actual={instructions} expected="Root instructions: prefer evidence over assertion." />
<AssertStringIncludes actual={instructions} expected="tests/fixtures/nested/AGENTS.md" />
<AssertStringIncludes actual={instructions} expected="Nested instructions: never edit a test to make it pass." />

<TestAgent>
  <TestAgent.Scenario agent="test" session="planner" src="./agents/discovery.md" />

  <Discovery
    instructions={instructions}
    planner="test"
    request="Add a health endpoint"
    worktree="."
    as="handoff"
  />
</TestAgent>

<AssertStringIncludes actual={handoff} expected="HANDOFF" />
</Test>
