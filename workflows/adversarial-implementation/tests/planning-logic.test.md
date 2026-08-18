# Planning document logic

The stages in this directory are the shipped-syntax part of the workflow, and
this document is the proof that they execute
([#290](https://github.com/taras/executable.md/issues/290)). It uses stub Agents
and document-supplied answers in one process and one working directory. Nothing
here needs WorkflowRun persistence, a Repository or Worktree, Git, a forge, or a
Worker Shell.

Nothing has to be stubbed for the stages to run. A workflow Agent receives no
checkout, no materialization of one, no working directory and no registered
directory (#302), so no stage reaches for one — each reasons over what its
prompt renders. `InstructionFiles` is what makes that concrete below: the exact
repository-relative paths and contents reach the prompts as captured data.

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
    as="handoff"
  />
</TestAgent>

<AssertStringIncludes actual={handoff} expected="HANDOFF" />
</Test>

## A passing verdict exits the planning loop after one iteration

The same instruction text has to reach `Planning`'s two prompts as well, so all
three scenarios below constrain the literal instruction contents. A plan prompt
that dropped them, or a verdict prompt that summarized them, fails here rather
than matching.

The loop breaks on the first passing verdict. The implementor scenario declares
exactly one turn, so a second plan prompt — which is what a revision would cause
on the next iteration — reports `scenario exhausted` instead of passing.

<Test name="a passing verdict returns true/true and sends no revision">

<InstructionFiles
  paths={["workflows/adversarial-implementation/tests/fixtures/AGENTS.md", "workflows/adversarial-implementation/tests/fixtures/nested/AGENTS.md"]}
  as="instructions"
/>

<TestAgent>
  <TestAgent.Scenario agent="implementor" session="implementor" src="./agents/plan-converges-implementor.md" />
  <TestAgent.Scenario agent="planner" session="planner" src="./agents/plan-converges-planner.md" />
  <TestAgent.Scenario agent="planner" session="user-checkpoint" src="./agents/checkpoint-no-choice.md" />

  <Planning
    handoff="HANDOFF the route is /health."
    handoffCheckpoint={{proceed: true, assessment: "HANDOFF-ASSESSED", response: "approved", rationale: "the handoff is clear"}}
    instructions={instructions}
    planner="planner"
    implementor="implementor"
    as="planning"
  />
</TestAgent>

<AssertEquals actual={planning.verdictPassed} expected={true} />
<AssertEquals actual={planning.decision.proceed} expected={true} />
<AssertEquals actual={planning.decision.requiresUser} expected={false} />
<AssertStringIncludes actual={planning.plan} expected="PLAN-V1" />
<AssertStringIncludes actual={planning.review} expected="REVIEW-PASS" />
</Test>

## A failed verdict returns its exact material to the same implementor session

A revision is not a summary. The implementor scenario's second turn constrains
the verdict's exact `review`, the exact `revisionPrompt`, and the complete
checkpoint record — assessment, response, and rationale — so a stage that
paraphrased any of them, or sent them to the planner session instead, fails.

Ordering is part of the claim: the revision is the implementor's *second* turn
and the revised plan its third, so a revision that arrived after the next plan
prompt, or not at all, reports a mismatch rather than passing.

The checkpoint scenario constrains the material it was handed, which is where
`Planning`'s `checkpointMaterial` reaches `UserCheckpoint`.

<Test name="a failed verdict revises in the same session, then converges">

<InstructionFiles paths={["workflows/adversarial-implementation/tests/fixtures/AGENTS.md"]} as="instructions" />

<TestAgent>
  <TestAgent.Scenario agent="implementor" session="implementor" src="./agents/revision-implementor.md" />
  <TestAgent.Scenario agent="planner" session="planner" src="./agents/revision-planner.md" />
  <TestAgent.Scenario agent="planner" session="user-checkpoint" src="./agents/checkpoint-twice-no-choice.md" />

  <Planning
    handoff="HANDOFF the route is /health."
    handoffCheckpoint={{proceed: true, assessment: "HANDOFF-ASSESSED", response: "approved", rationale: "the handoff is clear"}}
    instructions={instructions}
    planner="planner"
    implementor="implementor"
    as="planning"
  />
</TestAgent>

<AssertEquals actual={planning.verdictPassed} expected={true} />
<AssertStringIncludes actual={planning.plan} expected="PLAN-V2" />
<AssertStringIncludes actual={planning.review} expected="REVIEW-PASS the revised plan" />
<AssertEquals actual={planning.revisionPrompt} expected="" />
</Test>

## The bounded repair loops stop where the documents say

Both stages wrap `<SafeParse>` in a `<Loop max={2}>` and end with a final
`<Parse>`. That bound is exact: an initial malformed reply and two malformed
corrections reach the final `<Parse>`, and there is no third correction.

Each scenario below declares exactly three turns. A third correction prompt
would find the scenario exhausted and report *that* instead, so the assertion on
the parse failure is what proves the loop stopped where it should.

<Test name="Planning's verdict repair stops after two corrections">

<TestAgent>
  <TestAgent.Scenario agent="implementor" session="implementor" src="./agents/malformed-implementor.md" />
  <TestAgent.Scenario agent="planner" session="planner" src="./agents/malformed-planner.md" />

  <AssertThrows as="planningFailure" message="<Parse /> content is not JSON">
    <Planning
      handoff="HANDOFF the route is /health."
      handoffCheckpoint={{proceed: true, assessment: "A", response: "approved", rationale: "r"}}
      instructions="INSTRUCTIONS"
      planner="planner"
      implementor="implementor"
      as="planning"
    />
  </AssertThrows>
</TestAgent>

<AssertStringIncludes actual={planningFailure.message} expected="third malfo" />
</Test>

<Test name="UserCheckpoint's assessment repair stops after two corrections">

<TestAgent>
  <TestAgent.Scenario agent="planner" session="user-checkpoint" src="./agents/malformed-checkpoint.md" />

  <AssertThrows as="checkpointFailure" message="<Parse /> content is not JSON">
    <UserCheckpoint
      purpose="resolve the plan review"
      agent="planner"
      material="MATERIAL"
      as="checkpoint"
    />
  </AssertThrows>
</TestAgent>

<AssertStringIncludes actual={checkpointFailure.message} expected="third malfo" />
</Test>

## A material choice reaches the user, and a decline stays a decline

`UserCheckpoint` asks its agent whether the transition contains a material
choice, and the material it was handed has to reach that prompt intact — the
scenario constrains it. When the answer is yes, the checkpoint elicits, and the
question, options and recommendation the agent produced are what the person is
asked.

The `<Answers>` region here does not delegate, so a question this document did
not anticipate fails rather than reaching a host provider. What a decline must
never become is approval: `proceed` comes back `false`, and the caller's gate
reads that directly.

<Test name="requiresUser true elicits, and an explicit decline stays false">

<TestAgent>
  <TestAgent.Scenario agent="planner" session="user-checkpoint" src="./agents/checkpoint-material-choice.md" />

  <Answers>
  <Answer
    template="{?a}QUESTION-SCOPE Should the health route be public?{?b}public{?c}internal only{?d}RECOMMEND internal only.{?e}"
    value={{proceed: false, response: "internal only", rationale: "RATIONALE-DECLINE the public surface is out of scope"}}
  />

  <UserCheckpoint
    purpose="resolve the plan review"
    agent="planner"
    material="MATERIAL-UNDER-REVIEW the plan widens the public route surface."
    as="declined"
  />
  </Answers>
</TestAgent>

<AssertEquals actual={declined.requiresUser} expected={true} />
<AssertEquals actual={declined.proceed} expected={false} />
<AssertEquals actual={declined.response} expected="internal only" />
<AssertStringIncludes actual={declined.rationale} expected="RATIONALE-DECLINE" />
<AssertStringIncludes actual={declined.question} expected="QUESTION-SCOPE" />
<AssertStringIncludes actual={declined.recommendation} expected="RECOMMEND internal only." />
</Test>

When the agent reports no material choice, nothing is elicited and the `<Else>`
branch parses an explicit continue record. That record is the documented one,
word for word: a transition advances because a decision said so, never because
no decision was found.

<Test name="requiresUser false returns the documented explicit continue record">

<TestAgent>
  <TestAgent.Scenario agent="planner" session="user-checkpoint" src="./agents/checkpoint-no-choice.md" />

  <UserCheckpoint
    purpose="resolve the plan review"
    agent="planner"
    material="MATERIAL"
    as="continued"
  />
</TestAgent>

<AssertEquals actual={continued.requiresUser} expected={false} />
<AssertEquals actual={continued.proceed} expected={true} />
<AssertEquals actual={continued.response} expected="continue" />
<AssertEquals
  actual={continued.rationale}
  expected="The assessing agent found no material choice, so this transition needs no user decision."
/>
<AssertEquals actual={continued.question} expected="" />
</Test>


## Exhaustion runs where twenty agent turns fit

The seventh criterion — five failing iterations returning the exhausted outcome
— is proven in `scripts/tests/adversarial-planning-workflow.test.ts`. It costs
twenty agent turns in one `Planning` invocation, which does not fit a test's
fixed twenty-second timeout when each turn is an ACP round trip. That test runs
the same component from this directory, on this search path, with a synchronous
stub root Agent provider instead of the transport, and finishes in well under a
second.

Where `start.md` puts `<Implementation>` behind that gate, and reports
exhaustion as awaiting direction inside `<Dir>` and the root `<Output>`, stays
the composition probe's evidence.
