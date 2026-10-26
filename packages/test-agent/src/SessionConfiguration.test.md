# Scenario model and effort selection

<Let as="catalog" value={{selected:"fixture-small",options:[{id:"fixture-small",efforts:{selected:"low",options:["low","high"]}},{id:"fixture-review",efforts:{selected:"brief",options:["brief","deep"]}},{id:"no-effort"}]}} />
<TestAgent agent="reviewer">
<TestAgent.Scenario session="review" src="./SessionConfiguration.review.md" models={catalog} />
<TestAgent.Scenario session="defaults" src="./SessionConfiguration.defaults.md" models={catalog} />
<TestAgent.Scenario session="unavailable" src="./SessionConfiguration.unavailable.md" models={null} />

<Test name="configuration and dependent effort memory share one session" timeout="60s">
<Agent name="reviewer">
<Session name="review"><Prompt as="restored">restored</Prompt></Session>
<AssertStringIncludes actual={restored} expected="small low" />
<Session name="review" model="fixture-review" effort="deep"><Prompt as="configured">configured</Prompt></Session>
<AssertStringIncludes actual={configured} expected="review deep" />
<Session name="review" model="fixture-small" effort="high"><Prompt>remember high</Prompt></Session>
<Session name="review" model="fixture-review" effort="brief"><Prompt>other model</Prompt></Session>
<Session name="review" model="fixture-small"><Prompt>stored effort</Prompt></Session>
<Session name="review" model="fixture-small"><Prompt>same model</Prompt></Session>
<Session name="review"><Prompt>restored high</Prompt></Session>
</Agent>
</Test>

<Test name="catalog defaults are used without Session settings">
<Agent name="reviewer">
<Session name="defaults"><Prompt>defaults</Prompt></Session>
<Session name="defaults" model="fixture-small" effort="high"><Prompt>changed</Prompt></Session>
</Agent>
</Test>
<Test name="an independent Test starts at declared defaults">
<Agent name="reviewer"><Session name="defaults"><Prompt>defaults</Prompt></Session></Agent>
</Test>
<Test name="unavailable choices allow an unconfigured Session">
<Agent name="reviewer">
<Session name="unavailable"><Prompt>unavailable</Prompt></Session>
</Agent>
</Test>
</TestAgent>

<Test name="sibling nested Executions have independent catalogs" timeout="60s">
<Execution host="run" source={'<Agent name="reviewer"><Session name="defaults"><Prompt>defaults</Prompt></Session><Session name="defaults" model="fixture-small" effort="high"><Prompt>changed</Prompt></Session></Agent>'} as="first">
<TestAgent agent="reviewer"><TestAgent.Scenario session="defaults" src="./SessionConfiguration.defaults.md" models={catalog} /></TestAgent>
<AssertEquals actual={first.result.ok} expected={true} />
</Execution>
<Execution host="run" source={'<Agent name="reviewer"><Session name="defaults"><Prompt>defaults</Prompt></Session></Agent>'} as="second">
<TestAgent agent="reviewer"><TestAgent.Scenario session="defaults" src="./SessionConfiguration.defaults.md" models={catalog} /></TestAgent>
<AssertEquals actual={second.result.ok} expected={true} />
</Execution>
</Test>
