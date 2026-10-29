---
description: 'Check the committed API and run its real examples before migration. Use <Adversarial.Validate assignment={assignment} result={result} as="foundation" />.'
props:
  type: object
  properties:
    assignment: {type: object}
    result: {type: object}
  required: [assignment, result]
  additionalProperties: false
returns: {type: object}
---

<Let as="assignment" value={props.assignment} />
<Let as="result" value={props.result} />
<Adversarial.Schema as="schemas" />
<Parse schema={schemas.foundation} as="result"><Json value={result} /></Parse>
<If condition={result.outcome !== "complete"}><Fail message="Only a completed API foundation can admit migration." /></If>
<If condition={new Set(result.api.examples.map(example => example.name)).size !== result.api.examples.length || [...result.api.ownedPaths,...result.api.examples.map(example => example.path)].some(path => path.startsWith("/") || path.split("/").includes(".."))}>
<Fail message="Use distinct real example names and repository-relative API paths." />
</If>
<Ticket.Checkout repository={assignment.repository} as="checkout" />
<If condition={!checkout.clean || checkout.head !== result.revision}><Fail message="API feedback must identify the actual clean checkout HEAD." /></If>
<Dir path={assignment.repository}>
```bash exec as="ancestry"
git merge-base --is-ancestor {assignment.revision} {result.revision}
```
<If condition={ancestry.exitCode !== 0}><Fail message="The API commit must descend from its assigned source revision." /></If>
<Ticket.Signature repository={assignment.repository} revision={result.revision} as="signature" />
<If condition={signature.exitCode !== 0}><Fail message="Verify the API feedback commit's configured signature before migration." /></If>
<Ticket.ChangedPaths repository={assignment.repository} base={assignment.revision} head={result.revision} as="changes" />
<If condition={assignment.api === null && !result.api.ownedPaths.some(path => changes.paths.includes(path))}>
<Fail message="The initial foundation must implement an API-owned path, not only describe an interface." />
</If>
<Ticket.Text path={result.api.guide} as="guide" />
<If condition={guide.trim().length === 0}><Fail message="Provide the working API's usage and maintenance guide." /></If>
<Let as="checks" value={[]} />
<Let as="index" value={0} />
<Loop max={result.api.examples.length}>
<Let as="example" value={result.api.examples[index]} />
<Ticket.Text path={example.path} as="source" />
<If condition={source.trim().length === 0}><Fail message="A representative consumer must contain real code." /></If>
<Let as="object" value={"'" + (result.revision + ":" + example.path).replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="committed"
git cat-file -e {object}
```
<If condition={committed.exitCode !== 0}><Fail message="Commit each representative consumer before handing over its API." /></If>
```bash exec as="check"
{example.command}
```
<Let as="receipt" value={assignment.attempt + "/example-" + index + ".json"} />
<Dir path={assignment.attempt}><File path={"example-" + index + ".json"}><Json value={{revision:result.revision,example,...check}} /></File></Dir>
<If condition={check.exitCode !== 0}><Fail message={"API validation failed; preserve its first output at " + receipt + ". Migration has not started."} /></If>
<Let as="checks" value={[...checks,{revision:result.revision,command:example.command,outcome:"passed",artifact:receipt}]} />
<Let as="index" value={index + 1} />
</Loop>
</Dir>
<Ticket.Checkout repository={assignment.repository} as="after" />
<If condition={!after.clean || after.head !== result.revision}><Fail message="API checks changed source or HEAD. Preserve the checkout and receipts before continuing." /></If>
<Return value={{revision:result.revision,api:{...result.api,revision:result.revision},checks,changes,signature}} />
