```bash exec as="location"
pwd -P
```
<TempDir as="identityDirectory" />
<Test name="A2 production instructions and schema distinguish actual author from requested successor">
<Let as="assignment" value={{identityDirectory,phase:"discovery",work:"ordinary",repository:location.stdout.trim(),revision:"a".repeat(40),request:"Ask the original Architect for the missing boundary.",continuation:{phase:"implementation",role:"implementor"}}} />
<Let as="instructions"><Phase.Instructions role="planner" assignment={assignment} submission={{path:"/frozen/submission-guide.md"}} /></Let>
<AssertEquals actual={instructions.includes("next.role names the requested successor")} expected={false} />
<Let as="submission"><Phase.SubmissionInstructions role="planner" assignment={assignment} /></Let>
<AssertStringIncludes actual={submission} expected="discoveryRequests[].role and discoveryGaps[].request.role equal to planner" />
<AssertStringIncludes actual={submission} expected="next.role names the requested successor" />
<Let as="schemaText" value={submission.slice(submission.lastIndexOf('\n{'))} />
<Parse schema={{type:"object"}} as="schema">{schemaText}</Parse>
<AssertEquals actual={schema.properties.discoveryRequests.items.properties.role} expected={{const:"planner"}} />
<AssertEquals actual={schema.properties.discoveryGaps.items.properties.request.properties.role} expected={{const:"planner"}} />
<AssertEquals actual={schema.$defs.route.properties.role.enum.includes("architect")} expected={true} />
</Test>
<Test name="A2 sanitized incident fixtures retain rejected historical dispositions">
<Ticket.Text path={location.stdout.trim() + "/examples/adversarial-implementation/tests/fixtures/initial-planning-incidents.json"} as="text" />
<Parse schema={{type:"array"}} as="incidents">{text}</Parse>
<AssertEquals actual={incidents.map(incident => incident.issue)} expected={[1075,1081]} />
<AssertEquals actual={incidents.every(incident => incident.validationCode === "metadata-8" && !incident.canonicalResultCreated && !incident.implementationStarted && !incident.rawRewritten && incident.responseCorrections === 0 && incident.source.startsWith("/private/tmp/"))} expected={true} />
</Test>
