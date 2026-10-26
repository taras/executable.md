<TestAgent agent="reviewer">
<TestAgent.Scenario session="review" src="./SessionConfiguration.refusal-behavior.md" models={{selected:"A",options:[{id:"A",efforts:{selected:"low",options:["low","high"]}},{id:"B",efforts:{selected:"brief",options:["brief","deep"]}},{id:"none"}]}} />
<TestAgent.Scenario session="unavailable" src="./SessionConfiguration.unavailable.md" />
<Test name="invalid configuration starts no prompt and restores the original session" timeout="60s">
<Agent name="reviewer">
<ExpectRefusal message="Unknown model">
<Session name="review" model="unknown"><Prompt>not started</Prompt></Session>
</ExpectRefusal>
<ExpectRefusal message="Invalid effort level">
<Session name="review" model="B" effort="high"><Prompt>not started</Prompt></Session>
</ExpectRefusal>
<Session name="review"><Prompt>restored</Prompt></Session>
<ExpectRefusal message="Effort choices are unavailable">
<Session name="review" model="none" effort="high"><Prompt>not started</Prompt></Session>
</ExpectRefusal>
<Session name="review"><Prompt>still restored</Prompt></Session>
</Agent>
</Test>
<Test name="unavailable configuration starts no prompt">
<Agent name="reviewer">
<ExpectRefusal message="Model choices are unavailable">
<Session name="unavailable" model="A"><Prompt>not started</Prompt></Session>
</ExpectRefusal>
<Session name="unavailable"><Prompt>unavailable</Prompt></Session>
</Agent>
</Test>
</TestAgent>
