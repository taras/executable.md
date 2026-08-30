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

Naming a `<Session>` does not make it exist: that places it, and the first thing
inside it is what constructs it. So the prompt below is what establishes this
conversation — with no instruction layer at all — and the launch that follows is
the one meeting a session that already exists.

So the launch refuses, and says so.

<Test name="an established session is refused, never converted">
<Session name="claimed">
<Prompt as="occupant">who is in here?</Prompt>

<AssertThrows as="refusal" message="already carries a different XMD instruction layer">
<Session.Launch>
You are somebody else entirely.
</Session.Launch>
</AssertThrows>
</Session>

<AssertMatch actual={occupant} expected={/nobody but you/} />

The message says what happened; this says which refusal it was. A launch that
stopped for some other reason — no launcher, no native identity, a session
another owner holds — would carry a different class here and fail this test.

<AssertEquals actual={refusal.cause.failureClass} expected={"instructions-refused"} />
</Test>

## A session XMD names itself

The launches above let the provider name the session it created. An agent whose
native UI is handed the session it is to make works the other way round: XMD
names the session before the provider exists, and the native process creates it
under that name.

Nothing is created through ACP on that path. What makes it safe is that the
session's construction is written down — durably, once — before any process
exists, so the same session can never later be constructed the other way.

<TestAgent.Scenario agent="test-agent-client-native" session="implementer" src="./NativeSessionLaunch.implementer.md" />

<Test name="a launch names its own session, and the next one continues it">
<Agent name="test-agent-client-native">
<Session.Launch session="implementer">
You are the repository implementor. Follow the approved plan.
</Session.Launch>

The first launch chose this session's name and handed it to the native process.
Launching the same prepared body again continues that conversation rather than
naming a second one — which is only possible because the first launch wrote down
what it constructed.

<Session.Launch session="implementer">
You are the repository implementor. Follow the approved plan.
</Session.Launch>

A different body is a different instruction layer, and this provider replaces
neither the layer nor the conversation that already carries it.

<AssertThrows as="layer" message="already carries a different XMD instruction layer">
<Session.Launch session="implementer">
You are somebody else entirely.
</Session.Launch>
</AssertThrows>
</Agent>

<AssertEquals actual={layer.cause.failureClass} expected={"instructions-refused"} />
</Test>

## Joining the conversation a native process made

A session the native process created is still a conversation, and `<Prompt>` is
how a document joins it. Attaching does not convert it: the session keeps the
identity XMD chose for it, and ACP is told to open that exact conversation
rather than to make one.

So the same named `<Session>` continues where the launches left off, and what it
gets back is the answer that belongs to that conversation rather than to a fresh
one.

<TestAgent.Scenario agent="test-agent-client-native" session="attached" src="./NativeSessionLaunch.attached.md" />

<Test name="a prompt continues the session a native launch constructed">
<Agent name="test-agent-client-native">
<Session.Launch session="attached">
You are the repository implementor. Follow the approved plan.
</Session.Launch>

The second launch resumes rather than naming anything new — it allocates no
identity at all — and the prompt afterwards joins that same conversation.

<Session.Launch session="attached">
You are the repository implementor. Follow the approved plan.
</Session.Launch>

<Session name="attached">
<Prompt as="continued">where did we leave off?</Prompt>
</Session>
</Agent>

<AssertMatch actual={continued} expected={/the plan you approved/} />
</Test>

A prompt is the other order. It constructs the session through ACP, which
settles how that session was made, and a launch that would name the same session
is not asking to continue that conversation. It is asking to name a different
one, so it refuses before an identity is allocated, before a private file is
written, and before anything is started.

Naming the `<Session>` is not what does this. Placing a session settles nothing,
which is what leaves the `<Session.Launch>` above free to construct the very
session its enclosing `<Session>` named. It is the prompt below that constructs
this one, and the launch after it that finds a conversation already there.

<TestAgent.Scenario agent="test-agent-client-native" session="claimed" src="./NativeSessionLaunch.claimed.md" />

<Test name="an ACP-first session refuses a launch that would name it again">
<Agent name="test-agent-client-native">
<Session name="claimed">
<Prompt as="occupant">who is in here?</Prompt>

<AssertThrows as="conversion" message="already has an identity">
<Session.Launch>
You are somebody else entirely.
</Session.Launch>
</AssertThrows>
</Session>
</Agent>

<AssertMatch actual={occupant} expected={/nobody but you/} />

A construction route never converts, and the class says which refusal this was
rather than leaving it to the wording.

<AssertEquals actual={conversion.cause.failureClass} expected={"identity-unavailable"} />
</Test>
</TestAgent>
