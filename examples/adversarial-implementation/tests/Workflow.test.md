```bash exec as="suiteLocation"
pwd -P
```
<Let as="suiteRoot" value={suiteLocation.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all '" + suiteRoot.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />

<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Bounded test migration.",evidence:["/fixture/intent.md"]}} />

<Test name="fixed models separate design, migration and conditional architecture">
<Phase.Profile role="planner" design={true} assessment={assessment} as="design" />
<Phase.Profile role="planner" assessment={assessment} as="review" />
<Phase.Profile role="implementor" assessment={assessment} as="migration" />
<Phase.Profile role="architect" assessment={assessment} as="architecture" />
<AssertEquals actual={design} expected={{provider:"claude",model:"opus",effort:"high"}} />
<AssertEquals actual={review} expected={{provider:"claude",model:"opus",effort:"medium"}} />
<AssertEquals actual={migration} expected={{provider:"claude",model:"opus",effort:"high"}} />
<AssertEquals actual={architecture} expected={{provider:"codex",model:"gpt-6.1-sol",effort:"medium"}} />
</Test>

<Test name="the API contract requires intent, maintenance and real examples">
<Adversarial.Schema as="schemas" />
<SafeParse schema={schemas.api} as="paper"><Json value={{purpose:"Only an interface."}} /></SafeParse>
<AssertEquals actual={paper.ok} expected={false} />
</Test>

<Test name="existing extraction handles narration, fences and nested JSON">
<Each in={[
  '{"passed":true,"note":"brace } and quote \\\" kept","nested":{"items":[1,2]}}',
  'The checks are complete.\n```json\n{"passed":true}\n```\nSaved the evidence.',
  'Done.\n~~~\n{"passed":true}\n~~~',
  'Done: {"passed":true}',
  'Progress without a newline.```json\n{"passed":true}\n```',
  'R[1-4]: checks completed.```json\n{"passed":true}\n```',
  'Saved the receipt under [receipt](receipt.json).\n{"passed":true}',
  'Evidence:\n- [x] focused tests passed\n\n{"passed":true}',
  'Checks [1/3] done.\n{"passed":true}',
  'Kept the {quoted} placeholder.\n{"passed":true}',
  '```\n$ deno task test\nok | 3 passed\n```\n{"passed":true}',
  'Ran it (see ```log``` above).\n{"passed":true}',
  '```sh\necho "{not a result}"\n```\n{"passed":true}'
]} let="reply">
<Phase.Extract text={reply} as="extracted" />
<AssertEquals actual={extracted.ok} expected={true} />
<SafeParse schema={{type:"object",properties:{passed:{const:true}},required:["passed"]}} as="parsed">{extracted.json}</SafeParse>
<AssertEquals actual={parsed.ok} expected={true} />
</Each>
</Test>

<Test name="existing extraction rejects ambiguous and incomplete records">
<Each in={[
  '{"passed":false}\n{"passed":true}',
  '```json\n{"passed":true}\n```\n{"passed":true}',
  '```json\n{"passed":true}',
  'Broken: {"outer":{"passed":true}',
  'Broken: {"outer":}\n{"passed":true}',
  'No result is available.'
]} let="reply">
<Phase.Extract text={reply} as="extracted" />
<AssertEquals actual={extracted.ok} expected={false} />
</Each>
</Test>

<Test name="one object survives incidental arrays with original UTF-16 spans">
<Each in={["The selection names [\"title\",\"body\"].\n{\"passed\":true}", "The selection names [\"title\",\"body\"].\n```json\n{\"passed\":true}\n```", "The selection names [{\"nested\":[1,{\"escaped\":\"bracket ] and quote \\\"\"}]}].\n{\"passed\":true}", "The selection names [\n\"title\",\n{\"nested\":[1,2]}\n].\n{\"passed\":true}", "🦉 Completed.\n```json\n{\"passed\":true}\n```\nSaved.", "  {\"passed\":true}  "]} let="reply">
<Phase.Extract text={reply} as="extracted" />
<AssertEquals actual={extracted.ok} expected={true} />
<AssertEquals actual={extracted.json} expected={'{"passed":true}'} />
<AssertEquals actual={extracted.span} expected={{start:reply.indexOf('{"passed":true}'),end:reply.indexOf('{"passed":true}')+'{"passed":true}'.length}} />
<AssertEquals actual={reply.slice(extracted.span.start,extracted.span.end)} expected={'{"passed":true}'} />
</Each>
</Test>

<Test name="result positions, competing objects and malformed boundaries refuse">
<Each in={["{\"passed\":true}\n{\"passed\":true}", "{\"passed\":true}\n{\"work\":\"wrong\",\"passed\":false}", "Example: {\"example\":true}\n{\"passed\":true}", "[{\"passed\":true}]", "   [\"title\",\"body\"]\n{\"passed\":true}", "```json\n[\"title\",\"body\"]\n```\n{\"passed\":true}", "```\n[\"title\",\"body\"]\n```\n{\"passed\":true}", "Names [\"title\",\n{\"passed\":true}", "Names [\"title\",]\n{\"passed\":true}", "```json\ntrue\n```\n{\"passed\":true}", "```json\n\n```\n{\"passed\":true}", "```json\n{\"a\":1} {\"b\":2}\n```\n{\"passed\":true}", "true", "42", "\"done\"", "null", "```sh\necho done\n{\"passed\":true}"]} let="reply">
<Phase.Extract text={reply} as="extracted" />
<AssertEquals actual={extracted.ok} expected={false} />
</Each>
</Test>

<Test name="existing SafeParse owns result validation">
<Phase.Extract text={'Done: {"passed":"true"}'} as="extracted" />
<AssertEquals actual={extracted.ok} expected={true} />
<SafeParse schema={{type:"object",properties:{passed:{const:true}},required:["passed"]}} as="parsed">{extracted.json}</SafeParse>
<AssertEquals actual={parsed.ok} expected={false} />
</Test>

<Test name="an API conflict returns to Planner while other discovery keeps Architect">
<Let as="result" value={{phase:"implementation",outcome:"needs_discovery",next:{phase:"discovery",role:"planner"},handoff:"Planner: repair the API.",work:"test",revision:"1111111111111111111111111111111111111111",apiConflict:{expected:"resize",observed:"missing",reproducer:"call resize",artifact:"/witness"}}} />
<Phase.Route result={result} successor="review" role="planner" as="api" />
<AssertEquals actual={api.ok} expected={true} />
<Phase.Route result={{...result,apiConflict:undefined,next:{phase:"discovery",role:"architect"}}} successor="review" role="architect" as="other" />
<AssertEquals actual={other.ok} expected={true} />
</Test>

<Test name="metadata assignments stop before any workflow role">
<Ticket.Capture as="refused"><Phase.Run phase="review" role="planner" session="never-called" assignment={{}} attempt="/unused" responseProfile={{kind:"delivery-editorial",knownDocuments:[]}} as="unexpected" /></Ticket.Capture>
<AssertEquals actual={refused.status} expected="failed" />
<AssertStringIncludes actual={refused.failure} expected="metadata belong" />
</Test>
