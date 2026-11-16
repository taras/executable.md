# Named session identity and replay

<TestAgent agent="reviewer">
<TestAgent.Scenario session="review" src="./SessionConfiguration.review.md" models={{selected:"fixture-small",options:[{id:"fixture-small",efforts:{selected:"low",options:["low","high"]}},{id:"fixture-review",efforts:{selected:"brief",options:["brief","deep"]}}]}} />

<Test name="configuration shares the named session" timeout="60s">
<Agent name="reviewer">
<Session name="review"><Prompt>restored</Prompt></Session>
<Session name="review" model="fixture-review" effort="deep"><Prompt>configured</Prompt></Session>
</Agent>
</Test>

<Test name="an independent Test opens the named session at its default">
<Agent name="reviewer">
<Session name="review"><Prompt>restored</Prompt></Session>
</Agent>
</Test>
</TestAgent>
