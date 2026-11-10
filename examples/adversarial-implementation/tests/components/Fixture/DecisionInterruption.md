---
description: >-
  Repeat, contend for and interrupt decision resolution, publication and continuation.
  Use <Fixture.DecisionInterruption root={root} />.
props:
  type: object
  properties:
    root: {type: string}
  required: [root]
  additionalProperties: false
---

```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all --node-modules-dir=manual --cached-only --frozen '" + props.root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />
<Let as="quote" value={"'"} />

<TempDir>
<Fixture.DecisionHold root={props.root} scenario="decision" as="held" />
<Let as="ticket" value={held.saved.manifest.directory} />
<Let as="reservation" value={ticket + "/decisions/" + held.work.continuation.sha256} />
<Fixture.DecisionRequest held={held} name="a" as="a" />
<Fixture.DecisionRequest held={held} name="b" disposition="amend" as="b" />
<Dir path={ticket}>
```bash exec as="uncertain"
mkdir attempts/0001
```
</Dir>
<Fixture.Execution entry="resolve-decision" value={held.work} decision={a.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="Call 0001 already has retained or uncertain work" as="refused" />
<Dir path={ticket}>
```bash exec as="cleared"
rmdir attempts/0001
test ! -e decisions
```
</Dir>
<AssertEquals actual={[uncertain.exitCode,cleared.exitCode]} expected={[0,0]} />
<Dir path={held.fixture.root}><File path="held.json"><Json value={held.work} /></File></Dir>
<Dir path={ticket}><Glob include={["continuations/*.json"]} as="initial" /></Dir>
<Let as="entry" value={[props.root + "/examples/adversarial-implementation/resolve-decision.md","--props-record",held.fixture.root + "/held.json","--props-decision",a.path,"--raw","--include",props.root + "/examples/adversarial-implementation/tests/components","--include",props.root + "/examples/adversarial-implementation/components"].map(value => quote + value.replaceAll(quote,quote + '"' + quote + '"' + quote) + quote).join(" ")} />
<Let as="output" value={quote + held.fixture.root.replaceAll(quote,quote + '"' + quote + '"' + quote) + quote} />
<Dir path={held.fixture.repository}>
```bash exec as="contended"
{runner} {entry} > {output}/first.json 2> {output}/first.err &
first=$!
{runner} {entry} > {output}/second.json 2> {output}/second.err &
second=$!
wait "$first"; firstStatus=$?
wait "$second"; secondStatus=$?
printf '%s %s' "$firstStatus" "$secondStatus"
```
</Dir>
<AssertEquals actual={contended.stdout} expected="0 0" />
<Ticket.Text path={held.fixture.root + "/first.json"} as="firstText" />
<Ticket.Text path={held.fixture.root + "/second.json"} as="secondText" />
<Parse schema={{type:"object"}} as="first">{firstText}</Parse>
<Parse schema={{type:"object"}} as="second">{secondText}</Parse>
<Ticket.Text path={held.fixture.root + "/first.err"} as="firstError" />
<Ticket.Text path={held.fixture.root + "/second.err"} as="secondError" />
<Let as="contenders" value={[first,second]} />
<Let as="diagnostic" value={JSON.stringify({first,second,firstError,secondError})} />
<Let as="winners" value={contenders.filter(entry => entry.publication === "confirmed")} />
<If condition={!(winners.length >= 1 && winners.every(entry => JSON.stringify(entry.continuation) === JSON.stringify(winners[0].continuation)))}><Fail message={"Contenders must confirm one successor: " + diagnostic} /></If>
<If condition={!contenders.filter(entry => entry.publication !== "confirmed").every(entry => entry.status === "hold" && JSON.stringify(entry.continuation) === JSON.stringify(held.work.continuation) && entry.hold.includes(reservation))}><Fail message={"Unconfirmed contenders must retain the held reservation: " + diagnostic} /></If>
<Let as="successor" value={winners[0]} />
<Dir path={ticket}><Glob include={["continuations/*.json"]} as="published" /></Dir>
<AssertEquals actual={published.length} expected={initial.length + 1} />
<Ticket.Text path={reservation + "/receipt.json"} as="receiptText" />
<Fixture.Execution entry="resolve-decision" value={held.work} decision={a.path} repository={held.fixture.repository} root={props.root} as="child" />
<Parse schema={{type:"object"}} as="repeated">{child.stdout}</Parse>
<AssertEquals actual={[repeated.publication,repeated.continuation]} expected={["confirmed",successor.continuation]} />
<Ticket.Load record={successor} as="recorded" />
<Let as="decisionSnapshot" value={recorded.documents[a.request.decision.path].snapshot} />
<Let as="decisionOrigin" value={"'" + a.request.decision.path.replaceAll("'","'\"'\"'") + "'"} />
<Let as="provenanceOrigin" value={"'" + a.request.provenance.path.replaceAll("'","'\"'\"'") + "'"} />
<Let as="retainedDecision" value={"'" + decisionSnapshot.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="origins"
set -e
printf 'The original pathname was reused after the confirmed resolution.' > {decisionOrigin}
rm -- {provenanceOrigin}
```
<Fixture.Execution entry="resolve-decision" value={held.work} decision={a.path} repository={held.fixture.repository} root={props.root} as="child" />
<Parse schema={{type:"object"}} as="originRepeat">{child.stdout}</Parse>
<If condition={origins.exitCode !== 0 || originRepeat.publication !== "confirmed" || JSON.stringify(originRepeat.continuation) !== JSON.stringify(successor.continuation)}><Fail message={"A confirmed repeat must return its recorded successor after its origins change: " + JSON.stringify({origins,originRepeat})} /></If>
```bash exec as="corrupted"
cp -- {retainedDecision} {retainedDecision}.retained
printf 'altered retained decision' > {retainedDecision}
```
<Fixture.Execution entry="resolve-decision" value={held.work} decision={a.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="Retained ticket text changed" as="corruptedRepeat" />
```bash exec as="retainedRestored"
mv -- {retainedDecision}.retained {retainedDecision}
```
<AssertEquals actual={[corrupted.exitCode,retainedRestored.exitCode]} expected={[0,0]} />
<Fixture.Execution entry="resolve-decision" value={held.work} decision={b.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="already has a different recorded decision" as="conflicting" />
<Fixture.Execution entry="resolve-decision" value={successor} decision={a.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={successor.continuation} expected="stale continuation" as="stale" />
<Ticket.Text path={reservation + "/receipt.json"} as="receiptAfter" />
<AssertEquals actual={receiptAfter} expected={receiptText} />
<Dir path={ticket}><Glob include={["continuations/*.json"]} as="published" /></Dir>
<AssertEquals actual={published.length} expected={initial.length + 1} />
<Dir path={held.fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls.length} expected={1} />
<Fixture.Execution entry="continue" value={successor} repository={held.fixture.repository} steps={1} root={props.root} as="child" />
<Parse schema={{type:"object"}} as="continued">{child.stdout}</Parse>
<AssertEquals actual={continued.publication} expected="confirmed" />
<Fixture.Execution entry="continue" value={successor} repository={held.fixture.repository} steps={1} root={props.root} as="child" />
<Parse schema={{type:"object"}} as="again">{child.stdout}</Parse>
<AssertEquals actual={[again.publication,again.continuation]} expected={["held",successor.continuation]} />
<AssertStringIncludes actual={again.hold} expected="already has retained work" />
<Fixture.Execution entry="resolve-decision" value={held.work} decision={a.path} repository={held.fixture.repository} root={props.root} as="child" />
<Parse schema={{type:"object"}} as="replayed">{child.stdout}</Parse>
<AssertEquals actual={[replayed.publication,replayed.continuation]} expected={["confirmed",successor.continuation]} />
<Fixture.Execution entry="continue" value={replayed} repository={held.fixture.repository} steps={1} root={props.root} as="child" />
<Parse schema={{type:"object"}} as="resent">{child.stdout}</Parse>
<AssertEquals actual={resent.publication} expected="held" />
<Dir path={held.fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls.length} expected={2} />
</TempDir>

<TempDir>
<Fixture.DecisionHold root={props.root} scenario="decision" as="held" />
<Let as="ticket" value={held.saved.manifest.directory} />
<Let as="cuts" value={[
  {name:"publish-before",mode:"before",match:"/continuations/",outcome:"completed",successor:false},
  {name:"publish-after",mode:"after",match:"/continuations/",outcome:"completed",successor:true},
  {name:"after-reservation",mode:"before",match:"/snapshots/",outcome:"failed",successor:false},
  {name:"receipt-before",mode:"before",match:"/receipt.json",outcome:"failed",successor:true}
]} />
<Each in={cuts} let="cut">
<Let as="variant" value={{...held.saved,checkpoint:{...held.saved.checkpoint,hold:{...held.saved.checkpoint.hold,reason:held.saved.checkpoint.hold.reason + " Isolated cut: " + cut.name}}}} />
<Ticket.Publish record={variant} as="variantReturn" />
<Ticket.Text path={variantReturn.continuation.path} as="variantText" />
<Let as="reservation" value={ticket + "/decisions/" + variantReturn.continuation.sha256} />
<Fixture.DecisionRequest held={{...held,work:variantReturn}} name={cut.name} as="request" />
<Dir path={ticket}><Glob include={["continuations/*.json"]} as="before" /></Dir>
<Dir path={held.fixture.root}><File path={cut.name + ".json"}><Json value={variantReturn} /></File></Dir>
<Let as="cutArguments" value={[props.root + "/examples/adversarial-implementation/tests/decision-cut.md","--props-record",held.fixture.root + "/" + cut.name + ".json","--props-decision",request.path,"--plugin",props.root + "/packages/cli/tests/fixtures/decision-cut.mjs","--raw","--include",props.root + "/examples/adversarial-implementation/tests/components","--include",props.root + "/examples/adversarial-implementation/components"].map(value => quote + value.replaceAll(quote,quote + '"' + quote + '"' + quote) + quote).join(" ")} />
<Dir path={held.fixture.repository}>
```bash exec as="child"
XMD_DECISION_CUT_MODE={cut.mode} XMD_DECISION_CUT_MATCH={cut.match} {runner} {cutArguments}
```
</Dir>
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="interrupted">{child.stdout}</Parse>
<AssertEquals actual={[cut.name,interrupted.status]} expected={[cut.name,cut.outcome]} />
<If condition={cut.outcome === "completed"}>
<Parse schema={{type:"object"}} as="returned">{interrupted.output}</Parse>
<AssertEquals actual={[returned.publication,returned.continuation]} expected={["held",variantReturn.continuation]} />
<AssertEquals actual={[returned.failure.name,returned.failure.data.operation,returned.failure.data.phase]} expected={["FilesError","write","commit"]} />
<Else><AssertStringIncludes actual={interrupted.failure} expected="Files operation failed" /></Else>
</If>
<Dir path={ticket}><Glob include={["continuations/*.json"]} as="after" /></Dir>
<AssertEquals actual={[cut.name,after.length - before.length]} expected={[cut.name,cut.successor ? 1 : 0]} />
<Dir path={reservation}><Glob include={["*"]} as="reserved" /></Dir>
<AssertEquals actual={[cut.name,reserved]} expected={[cut.name,["request.json"]]} />
<Fixture.Execution entry="resolve-decision" value={variantReturn} decision={request.path} repository={held.fixture.repository} root={props.root} as="repeat" />
<Parse schema={{type:"object"}} as="repeated">{repeat.stdout}</Parse>
<AssertEquals actual={[cut.name,repeated.publication,repeated.continuation]} expected={[cut.name,"held",variantReturn.continuation]} />
<AssertStringIncludes actual={repeated.hold} expected="without a confirmed receipt" />
<Ticket.Text path={variantReturn.continuation.path} as="variantAfter" />
<AssertEquals actual={[cut.name,variantAfter]} expected={[cut.name,variantText]} />
<Dir path={ticket}><Glob include={["continuations/*.json"]} as="repeatedAfter" /></Dir>
<AssertEquals actual={repeatedAfter.length} expected={after.length} />
</Each>
<Ticket.Publish record={{...held.saved,checkpoint:{...held.saved.checkpoint,hold:{...held.saved.checkpoint.hold,reason:held.saved.checkpoint.hold.reason + " Isolated non-exclusive mkdir contention."}}}} as="contendedReturn" />
<Let as="contendedReservation" value={ticket + "/decisions/" + contendedReturn.continuation.sha256} />
<Fixture.DecisionRequest held={{...held,work:contendedReturn}} name="non-exclusive-mkdir" as="contendedRequest" />
<Dir path={held.fixture.root}><File path="non-exclusive.json"><Json value={contendedReturn} /></File></Dir>
<Dir path={ticket}><Glob include={["continuations/*.json"]} as="beforeContention" /></Dir>
<Let as="contendedEntry" value={[props.root + "/examples/adversarial-implementation/resolve-decision.md","--props-record",held.fixture.root + "/non-exclusive.json","--props-decision",contendedRequest.path,"--raw","--include",props.root + "/examples/adversarial-implementation/tests/components","--include",props.root + "/examples/adversarial-implementation/components"].map(value => quote + value.replaceAll(quote,quote + '"' + quote + '"' + quote) + quote).join(" ")} />
<Let as="contendedRoot" value={quote + held.fixture.root.replaceAll(quote,quote + '"' + quote + '"' + quote) + quote} />
<Dir path={held.fixture.repository}>
```bash exec as="nonExclusive"
real=$(command -v mkdir) || exit 1
"$real" -p -- {contendedRoot}/non-exclusive-bin || exit 1
cat > {contendedRoot}/non-exclusive-bin/mkdir <<'SHIM' || exit 1
#!/bin/bash
# A plain mkdir that checks existence, creates, and reports success when the
# creation fails on a directory, as uutils coreutils 0.10 and earlier do.
# Callers of one target meet after the check, so concurrent callers both pass it.
recursive=false
if test "$1" = "-p"; then recursive=true; shift; fi
if test "$1" = "--"; then shift; fi
target=$1
if test "$recursive" = false && test -e "$target"; then echo "mkdir: $target: File exists" >&2; exit 1; fi
meeting="$XMD_MKDIR_MEETING/$(printf %s "$target" | cksum | cut -d' ' -f1)"
"$XMD_REAL_MKDIR" -p -- "$meeting" || exit 1
: > "$meeting/$$" || exit 1
for attempt in $(seq 600); do set -- "$meeting"/*; if test "$#" -ge 2; then break; fi; sleep 0.05; done
if test "$recursive" = true; then exec "$XMD_REAL_MKDIR" -p -- "$target"; fi
"$XMD_REAL_MKDIR" -- "$target" 2>/dev/null || test -d "$target"
SHIM
chmod +x {contendedRoot}/non-exclusive-bin/mkdir || exit 1
PATH={contendedRoot}/non-exclusive-bin:"$PATH" XMD_REAL_MKDIR="$real" XMD_MKDIR_MEETING={contendedRoot}/non-exclusive-meeting {runner} {contendedEntry} > {contendedRoot}/non-exclusive-first.json 2> {contendedRoot}/non-exclusive-first.err &
first=$!
PATH={contendedRoot}/non-exclusive-bin:"$PATH" XMD_REAL_MKDIR="$real" XMD_MKDIR_MEETING={contendedRoot}/non-exclusive-meeting {runner} {contendedEntry} > {contendedRoot}/non-exclusive-second.json 2> {contendedRoot}/non-exclusive-second.err &
second=$!
wait "$first"; firstStatus=$?
wait "$second"; secondStatus=$?
printf '%s %s' "$firstStatus" "$secondStatus"
```
</Dir>
<AssertEquals actual={nonExclusive.stdout} expected="0 0" />
<Ticket.Text path={held.fixture.root + "/non-exclusive-first.json"} as="firstText" />
<Ticket.Text path={held.fixture.root + "/non-exclusive-second.json"} as="secondText" />
<Parse schema={{type:"object"}} as="first">{firstText}</Parse>
<Parse schema={{type:"object"}} as="second">{secondText}</Parse>
<Dir path={held.fixture.root + "/non-exclusive-meeting"}><Glob include={["*/*"]} as="arrivals" /></Dir>
<Let as="contenders" value={[first,second]} />
<Let as="diagnostic" value={JSON.stringify({first,second,arrivals})} />
<If condition={!(arrivals.length >= 2 && contenders.filter(entry => entry.publication === "confirmed").length === 1 && contenders.filter(entry => entry.publication !== "confirmed").every(entry => entry.status === "hold" && JSON.stringify(entry.continuation) === JSON.stringify(contendedReturn.continuation) && entry.hold.includes("Another resolution holds the decision reservation " + contendedReservation)))}><Fail message={"Contenders that both pass the reservation check must confirm one successor even when mkdir is not exclusive: " + diagnostic} /></If>
<Dir path={ticket}><Glob include={["continuations/*.json"]} as="afterContention" /></Dir>
<AssertEquals actual={afterContention.length} expected={beforeContention.length + 1} />
<Dir path={contendedReservation}><Glob include={["*"]} as="contendedRecords" /></Dir>
<AssertEquals actual={contendedRecords} expected={["receipt.json","request.json"]} />
<Ticket.Publish record={{...held.saved,checkpoint:{...held.saved.checkpoint,hold:{...held.saved.checkpoint.hold,reason:held.saved.checkpoint.hold.reason + " Isolated uncertain call."}}}} as="variantReturn" />
<Fixture.DecisionRequest held={{...held,work:variantReturn}} name="uncertain-call" as="request" />
<Fixture.Execution entry="resolve-decision" value={variantReturn} decision={request.path} repository={held.fixture.repository} root={props.root} as="child" />
<Parse schema={{type:"object"}} as="resolved">{child.stdout}</Parse>
<AssertEquals actual={resolved.publication} expected="confirmed" />
<Dir path={ticket}>
```bash exec as="uncertain"
mkdir calls/0001
```
</Dir>
<Fixture.Execution entry="continue" value={resolved} repository={held.fixture.repository} steps={1} root={props.root} as="child" />
<Parse schema={{type:"object"}} as="withheld">{child.stdout}</Parse>
<AssertEquals actual={[uncertain.exitCode,withheld.publication,withheld.continuation]} expected={[0,"held",resolved.continuation]} />
<Dir path={held.fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls.length} expected={1} />
</TempDir>
