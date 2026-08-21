# Attached service ping-pong

<Test name="Two attached services complete a nonce-bearing ping-pong exchange">
<AttachedPingPongProvider>
<Let as="pingPongResponse">
<Sample prompt="complete ping-pong" />
</Let>
<AssertEquals actual={pingPongResponse} expected={"\n\nping→pong→ping"} />
</AttachedPingPongProvider>
</Test>
