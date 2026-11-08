---
description: >-
  Keep the inherited snapshot, descriptor, protection, permission and capacity refusals
  for decision inputs. Use <Fixture.DecisionBoundary root={root} />.
props:
  type: object
  properties:
    root: {type: string}
  required: [root]
  additionalProperties: false
---

<TempDir>
<Fixture.DecisionHold root={props.root} scenario="decision" as="held" />
<Let as="saved" value={held.saved} />
<Let as="ticket" value={saved.manifest.directory} />
<Let as="quote" value={"'"} />
<Let as="resultSnapshot" value={saved.documents[saved.calls.at(-1).result].snapshot} />
<Fixture.DecisionRequest held={held} name="snapshot" as="snapshotRequest" />
<Let as="snapshotPath" value={"'" + resultSnapshot.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="altered"
cp -- {snapshotPath} {snapshotPath}.original
printf 'altered retained result' > {snapshotPath}
```
<Fixture.Execution entry="resolve-decision" value={held.work} decision={snapshotRequest.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="Retained ticket text changed" as="refused" />
```bash exec as="removed"
rm -- {snapshotPath}
```
<Fixture.Execution entry="resolve-decision" value={held.work} decision={snapshotRequest.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="" as="refused" />
```bash exec as="restored"
mv -- {snapshotPath}.original {snapshotPath}
```
<AssertEquals actual={[altered.exitCode,removed.exitCode,restored.exitCode]} expected={[0,0,0]} />
<Fixture.DecisionRequest held={held} name="changed-text" as="changed" />
<Dir path={changed.directory}><File path="decision.md">Rewritten after the request was bound.</File></Dir>
<Fixture.Execution entry="resolve-decision" value={held.work} decision={changed.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="Decision input differs from its descriptor" as="refused" />
<Let as="secretPath" value={held.fixture.root + "/secret.md"} />
<Let as="deniedPath" value={held.fixture.root + "/denied.md"} />
<Let as="secretQuoted" value={"'" + secretPath.replaceAll("'","'\"'\"'") + "'"} />
<Let as="deniedQuoted" value={"'" + deniedPath.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="described"
set -e
printf '%s%s%s' ghp _ abcdefghijklmnopqrstuvwxyz0123456789 > {secretQuoted}
printf 'Readable only before its permission was withdrawn.' > {deniedQuoted}
digest() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
printf '{"secret":{"utf8Bytes":%s,"sha256":"%s"},"denied":{"utf8Bytes":%s,"sha256":"%s"}}' "$(wc -c < {secretQuoted} | tr -d ' ')" "$(digest {secretQuoted})" "$(wc -c < {deniedQuoted} | tr -d ' ')" "$(digest {deniedQuoted})"
chmod 000 {deniedQuoted}
```
<If condition={described.exitCode !== 0}><Fail message={described.stderr} /></If>
<Parse schema={{type:"object"}} as="facts">{described.stdout}</Parse>
<Let as="refusals" value={[
  {name:"protected",inputs:[{path:secretPath,...facts.secret}],override:{},expected:"did not clear enabled protection"},
  {name:"denied",inputs:[{path:deniedPath,...facts.denied}],override:{},expected:"Cannot read " + deniedPath},
  {name:"text-capacity",inputs:[{path:deniedPath,utf8Bytes:8388609,sha256:facts.denied.sha256}],override:{},expected:"8388608"},
  {name:"recorded-changed",inputs:[{path:held.evidence,utf8Bytes:7,sha256:"3".repeat(64)}],override:{},expected:"give changed text a fresh reference"}
]} />
<Each in={refusals} let="refusal">
<Fixture.DecisionRequest held={held} name={refusal.name} acceptedInputs={refusal.inputs} override={refusal.override} as="request" />
<Fixture.Execution entry="resolve-decision" value={held.work} decision={request.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected={refusal.expected} as="refused" />
</Each>
<Fixture.DecisionRequest held={held} name="request-capacity" as="oversized" />
<Let as="padding" value={" ".repeat(1048577)} />
<Let as="oversizedText" value={JSON.stringify(oversized.request) + padding} />
<Dir path={oversized.directory}><File path="decision.json">{oversizedText}</File></Dir>
<Fixture.Execution entry="resolve-decision" value={held.work} decision={oversized.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected={"Cannot read " + oversized.path + " within 1048576 UTF-8 bytes"} as="refused" />
```bash exec as="permitted"
chmod 644 {deniedQuoted}
```
<Dir path={ticket}><Glob include={["decisions/**","calls/0001/**"]} as="effects" /></Dir>
<AssertEquals actual={effects} expected={[]} />
<Ticket.Text path={held.evidence} as="originalEvidence" />
<Dir path={held.fixture.root}><File path="accepted.md">Accepted scope rewritten after launch.</File><File path="accepted-revised.md">Accepted scope rewritten after launch.</File></Dir>
<Ticket.Documents repository={held.fixture.root} directory={held.fixture.root + "/described"} paths={[held.fixture.root + "/accepted-revised.md"]} as="revisedFacts" />
<Let as="revised" value={revisedFacts[held.fixture.root + "/accepted-revised.md"]} />
<Let as="retained" value={saved.documents[held.evidence]} />
<Fixture.DecisionRequest held={held} name="references" disposition="amend" acceptedInputs={[{path:retained.path,utf8Bytes:retained.utf8Bytes,sha256:retained.sha256},{path:revised.path,utf8Bytes:revised.utf8Bytes,sha256:revised.sha256}]} as="references" />
<Fixture.Execution entry="resolve-decision" value={held.work} decision={references.path} repository={held.fixture.repository} root={props.root} as="child" />
<Parse schema={{type:"object"}} as="resolvedReturn">{child.stdout}</Parse>
<If condition={resolvedReturn.publication !== "confirmed"}><Fail message={JSON.stringify(resolvedReturn)} /></If>
<Ticket.Load record={resolvedReturn} as="resolved" />
<AssertEquals actual={resolved.documents[held.evidence]} expected={retained} />
<AssertEquals actual={[resolved.documents[revised.path].sha256,resolved.documents[revised.path].observation]} expected={[revised.sha256,"file"]} />
<Fixture.Execution entry="continue" value={resolvedReturn} repository={held.fixture.repository} steps={1} root={props.root} as="child" />
<Parse schema={{type:"object"}} as="continuedReturn">{child.stdout}</Parse>
<Ticket.Load record={continuedReturn} as="continued" />
<Let as="architect" value={continued.calls.at(-1)} />
<Ticket.Text path={architect.attempt + "/called.json"} as="calledText" />
<Parse schema={{type:"object"}} as="called">{calledText}</Parse>
<AssertEquals actual={[architect.role,called.inputs.find(input => input.path === held.evidence)?.content,called.inputs.find(input => input.path === revised.path)?.content]} expected={["architect",originalEvidence,"Accepted scope rewritten after launch."]} />
</TempDir>
