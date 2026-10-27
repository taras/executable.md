# Development role delegation

The suite invokes the repository components through the ordinary include path.
The static project supplies literal instruction files. Its executable-looking
markup must reach each exact prompt as text. The selected test-only Plugin routes
session names to TestAgent without changing the public wrappers.

<Test name="B1: Architect validates its closed input contract before a turn">
<AssertThrows message="must have required property 'session'" as="missingSession"><Development.Architect request="unused" /></AssertThrows>
<AssertEquals actual={missingSession.cause.componentName} expected="Development.Architect" />
<AssertThrows message="must have required property 'request'" as="missingRequest"><Development.Architect session="unused" /></AssertThrows>
<AssertEquals actual={missingRequest.cause.componentName} expected="Development.Architect" />
<AssertThrows message="must be string" as="wrongRequest"><Development.Architect session="unused" request={42} /></AssertThrows>
<AssertEquals actual={wrongRequest.cause.componentName} expected="Development.Architect" />
<AssertThrows message="must be string" as="wrongSession"><Development.Architect session={42} request="unused" /></AssertThrows>
<AssertEquals actual={wrongSession.cause.componentName} expected="Development.Architect" />
<AssertThrows message="must be string" as="wrongModel"><Development.Architect session="unused" request="unused" model={42} /></AssertThrows>
<AssertEquals actual={wrongModel.cause.componentName} expected="Development.Architect" />
<AssertThrows message="must NOT have additional properties" as="unknown"><Development.Architect session="unused" request="unused" extra="refused" /></AssertThrows>
<AssertEquals actual={unknown.cause.componentName} expected="Development.Architect" />
</Test>

<Test name="B1: Planner validates its closed input contract before a turn">
<AssertThrows message="must have required property 'session'" as="missingSession"><Development.Planner request="unused" /></AssertThrows>
<AssertEquals actual={missingSession.cause.componentName} expected="Development.Planner" />
<AssertThrows message="must have required property 'request'" as="missingRequest"><Development.Planner session="unused" /></AssertThrows>
<AssertEquals actual={missingRequest.cause.componentName} expected="Development.Planner" />
<AssertThrows message="must be string" as="wrongRequest"><Development.Planner session="unused" request={42} /></AssertThrows>
<AssertEquals actual={wrongRequest.cause.componentName} expected="Development.Planner" />
<AssertThrows message="must be string" as="wrongSession"><Development.Planner session={42} request="unused" /></AssertThrows>
<AssertEquals actual={wrongSession.cause.componentName} expected="Development.Planner" />
<AssertThrows message="must be string" as="wrongModel"><Development.Planner session="unused" request="unused" model={42} /></AssertThrows>
<AssertEquals actual={wrongModel.cause.componentName} expected="Development.Planner" />
<AssertThrows message="must NOT have additional properties" as="unknown"><Development.Planner session="unused" request="unused" extra="refused" /></AssertThrows>
<AssertEquals actual={unknown.cause.componentName} expected="Development.Planner" />
</Test>

<Test name="B1: Implementor validates its closed input contract before a turn">
<AssertThrows message="must have required property 'session'" as="missingSession"><Development.Implementor request="unused" /></AssertThrows>
<AssertEquals actual={missingSession.cause.componentName} expected="Development.Implementor" />
<AssertThrows message="must have required property 'request'" as="missingRequest"><Development.Implementor session="unused" /></AssertThrows>
<AssertEquals actual={missingRequest.cause.componentName} expected="Development.Implementor" />
<AssertThrows message="must be string" as="wrongRequest"><Development.Implementor session="unused" request={42} /></AssertThrows>
<AssertEquals actual={wrongRequest.cause.componentName} expected="Development.Implementor" />
<AssertThrows message="must be string" as="wrongSession"><Development.Implementor session={42} request="unused" /></AssertThrows>
<AssertEquals actual={wrongSession.cause.componentName} expected="Development.Implementor" />
<AssertThrows message="must be string" as="wrongModel"><Development.Implementor session="unused" request="unused" model={42} /></AssertThrows>
<AssertEquals actual={wrongModel.cause.componentName} expected="Development.Implementor" />
<AssertThrows message="must NOT have additional properties" as="unknown"><Development.Implementor session="unused" request="unused" extra="refused" /></AssertThrows>
<AssertEquals actual={unknown.cause.componentName} expected="Development.Implementor" />
</Test>

## Literal prompts and complete replies

B2–B4 and B7 use three distinct supplied session names and one additional
uncaptured invocation. The child compares all three captured replies exactly;
its only output is the uncaptured reply. The different TestAgent default makes
a missing Codex selection fail. The explicit model in one invocation exercises
the public prop while the test route remains unconfigured.

<Test name="B2 B3 B4 B7: roles receive literal instructions and preserve Markdown replies" timeout="120s">
<Dir path="components/Development/tests/fixtures/project">
<File path="captures.md" as="childSource" />
<Execution host="run" source={childSource} as="run">
<TestAgent agent="different-default">
<TestAgent.Scenario agent="codex" session="capture-architect" src="./tests/fixtures/agents/architect.md" />
<TestAgent.Scenario agent="codex" session="capture-planner" src="./tests/fixtures/agents/planner.md" />
<TestAgent.Scenario agent="codex" session="capture-implementor" src="./tests/fixtures/agents/implementor.md" />
<TestAgent.Scenario agent="codex" session="render-architect" src="./tests/fixtures/agents/render.md" />
</TestAgent>
<CollectOutput as="output" />

<AssertEquals actual={run.kind} expected="settled" />
<AssertEquals actual={run.result.ok} expected={true} msg={run.result.ok ? "Child completed" : run.result.error.message} />
<AssertEquals actual={output} expected={"## Rendered Architect reply\n\n**Complete** Markdown.\n\n- one\n- two"} />
</Execution>
</Dir>
</Test>

## A failed turn stops the coordinator

The nested run installs TestAgent as child configuration, so its ordinary test
wrapper's prompt-failure policy cannot mask a missing `throwOnError`. A matched
turn fails deliberately. Failed completion alone is insufficient: the following
coordinator marker must also be absent.

<Test name="B5: a failed role turn prevents following work" timeout="120s">
<Dir path="components/Development/tests/fixtures/project">
<File path="failure.md" as="childSource" />
<Execution host="run" source={childSource} as="run">
<TestAgent agent="different-default">
<TestAgent.Scenario agent="codex" session="failing-implementor" src="./tests/fixtures/agents/failure.md" />
</TestAgent>
<CollectOutput as="output" />

<AssertEquals actual={run.kind} expected="settled" />
<AssertEquals actual={run.result.ok} expected={false} />
<AssertStringIncludes actual={run.result.error.message} expected="SCRIPTED_ROLE_FAILURE" />
<AssertEquals actual={output.includes("FOLLOWING_COORDINATOR_MARKER")} expected={false} />
</Execution>
</Dir>
</Test>

## Preserve both correction attempts

These revisions are fixture labels, not Git SHAs. The child retains the first
Implementor reply, sends the Planner's exact rejection in its correction
request, and retains the second reply. Both review requests name fixture-r2.
The scenarios require their exact complete prompts; the child asserts both
attempts and both verdicts after the correction.

<Test name="B6: a correction keeps both attempts and reviews the corrected revision" timeout="120s">
<Dir path="components/Development/tests/fixtures/project">
<File path="correction.md" as="childSource" />
<Execution host="run" source={childSource} as="run">
<TestAgent agent="different-default">
<TestAgent.Scenario agent="codex" session="journey-implementor" src="./tests/fixtures/agents/journey-implementor.md" />
<TestAgent.Scenario agent="codex" session="journey-planner" src="./tests/fixtures/agents/journey-planner.md" />
<TestAgent.Scenario agent="codex" session="journey-architect" src="./tests/fixtures/agents/journey-architect.md" />
</TestAgent>
<CollectOutput as="output" />

<AssertEquals actual={run.kind} expected="settled" />
<AssertEquals actual={run.result.ok} expected={true} msg={run.result.ok ? "Child completed" : run.result.error.message} />
<AssertStringIncludes actual={output} expected="Correction handoff verified for fixture-r2; fixture-r1 remains preserved." />
</Execution>
</Dir>
</Test>

These deterministic children prove prompt composition and text handoff. The
coordinator's real entries supply configured Codex/model evidence, provider
conversation continuity, Git-confirmed commits and independent verdicts.
