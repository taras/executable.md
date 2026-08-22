# Native session launch

`<Session.Launch>` prepares one agent session, installs the text it renders as
that session's instruction layer, and hands the session's native UI the
terminal. The launch is not a turn: nothing is said to the agent, and nothing
the agent would have answered is consumed.

Everything below runs against the deterministic test agent, so the "native UI"
is a recorded request rather than a process, and the answers are scripted.

<TestAgent>
<TestAgent.Scenario session="implementer" src="./NativeSessionLaunch.implementer.md" />
<TestAgent.Scenario session="claimed" src="./NativeSessionLaunch.claimed.md" />

A launch names the session it prepares. That session does not exist yet, so the
launch is what constructs it — carrying exactly the text this body rendered.

The prompt afterwards is the proof that no turn was spent: the scenario holds
one stage, and it is still there.

<Test name="a launch prepares its own session and spends no turn">
<Session.Launch session="implementer">
You are the repository implementor. Follow the approved plan.
</Session.Launch>

<Session name="implementer">
<Prompt as="answer">what changed?</Prompt>
</Session>

<AssertMatch actual={answer} expected={/nothing yet/} />
</Test>

A session that already exists is a different matter. ACPX fixes a session's
instruction layer when its ACP session is created, so putting a different one in
force would mean discarding the session — and nothing here can show that would
be safe, because a transcript this side can read is empty whether or not the
session was ever used.

So the launch refuses, and says so.

<Test name="an established session is refused, never converted">
<Session name="claimed">
<AssertThrows as="refusal" message="already carries a different XMD instruction layer">
<Session.Launch>
You are somebody else entirely.
</Session.Launch>
</AssertThrows>
</Session>

The message says what happened; this says which refusal it was. A launch that
stopped for some other reason — no launcher, no native identity, a session
another owner holds — would carry a different class here and fail this test.

<AssertEquals actual={refusal.cause.failureClass} expected={"instructions-refused"} />
</Test>
</TestAgent>
