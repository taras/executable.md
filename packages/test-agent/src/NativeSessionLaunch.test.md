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

## A session XMD names itself

The launches above let the provider name the session it created. An agent whose
native UI can be handed an identity works the other way round: XMD allocates the
identity before the provider exists, hands it to the native process, and can
reattach to that same conversation afterwards.

That only holds together while the build that created the session can be
recognized later, so the launch observes one and binds it. Both facts are
settled while this session is owned, and before anything is created.

<TestAgent.Scenario agent="test-agent-client-native" session="implementer" src="./NativeSessionLaunch.implementer.md" />

<Test name="a launch XMD named continues into the prompt that follows it">
<Agent name="test-agent-client-native">
<Session.Launch session="implementer">
You are the repository implementor. Follow the approved plan.
</Session.Launch>

The scenario holds one scripted stage. The launch created a session rather than
spending a turn, so the stage is still there for the prompt that follows — and
the prompt reaches the same conversation the launch named.

The prompt names the session directly rather than being wrapped in one. An
enclosing `<Session>` is eager, and establishing the session first is what the
next test is about.

<Prompt session="implementer" as="continued">what changed?</Prompt>
</Agent>

<AssertMatch actual={continued} expected={/nothing yet/} />
</Test>

An eager `<Session>` is the other order: it establishes the session through ACP
first, which settles how that session was constructed. A launch that would
allocate an identity for it is not asking to continue that conversation — it is
asking to name a different one — so it refuses, before observing a build,
allocating an identity, detaching, or starting anything.

<TestAgent.Scenario agent="test-agent-client-native" session="claimed" src="./NativeSessionLaunch.claimed.md" />

<Test name="an ACP-first session refuses a launch that would name it again">
<Agent name="test-agent-client-native">
<Session name="claimed">
<AssertThrows as="conversion" message="already has an identity of its own">
<Session.Launch>
You are somebody else entirely.
</Session.Launch>
</AssertThrows>
</Session>
</Agent>

A construction route never converts, and the class says which refusal this was
rather than leaving it to the wording.

<AssertEquals actual={conversion.cause.failureClass} expected={"identity-unavailable"} />
</Test>
</TestAgent>
