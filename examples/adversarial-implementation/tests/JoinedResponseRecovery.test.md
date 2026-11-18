<Test name="workflow-owned recovery runtime suite" timeout="1200s">
<Recovery.RunSuite as="runtime" />
<If condition={runtime.exitCode !== 0}><Fail message={runtime.stdout + "\n" + runtime.stderr} /></If>
</Test>
