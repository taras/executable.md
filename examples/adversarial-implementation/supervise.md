---
props:
  type: object
  properties:
    step:
      type: object
      properties:
        xmd: {type: array, minItems: 1, items: {type: string, minLength: 1}}
        progress: {type: array, minItems: 1, items: {type: string, minLength: 1}}
        attachment: {type: string, pattern: '^/'}
        message:
          type: object
          properties:
            execution: {type: string, minLength: 1}
            conversation: {type: string, minLength: 1}
            id: {type: string, minLength: 1}
          required: [execution, conversation, id]
          additionalProperties: false
        entry: {type: integer, minimum: 1}
        resultFile: {type: string, pattern: '^/'}
        resultSchema: {type: object}
      required: [xmd, progress, attachment, message, entry]
      additionalProperties: false
  required: [step]
  additionalProperties: false
returns:
  type: object
---

<Let as="step" value={props.step} />
<Let as="followArguments" value={[...step.xmd,"sidekick","read","--attach",step.attachment,"message",encodeURIComponent(JSON.stringify(step.message)),"--follow"]} />
<Let as="followCommand" value={followArguments.map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
<Let as="progressCommand" value={[...step.progress,String(step.entry)].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />

<Let as="followedText">
```bash exec
set -o pipefail
{followCommand} | {progressCommand}
follow_status=$?
if [ "$follow_status" -ne 0 ]; then
  printf '{"followExitCode":%s}\n' "$follow_status"
fi
```
</Let>

<Let as="lastLine" value={followedText.trim().split("\n").at(-1) ?? ""} />
<SafeParse schema={{type:"object",properties:{message:{const:step.message},ending:{type:"object",properties:{joined:{const:true},outcome:{enum:["completed","failed","cancelled"]}},required:["joined","outcome"]}},required:["message","ending"]}} as="exchange">{lastLine}</SafeParse>
<Let as="report" value={{entry:step.entry,status:"unavailable",joinedExchange:false,diagnostic:"Follow failed or returned no validated joined receipt. Inspect stderr and reconcile the original call; no work was resent.",resultStatus:"unavailable",result:null}} />
<If condition={exchange.ok}>
  <Let as="report" value={{...report,joinedExchange:true,diagnostic:"The attachment could not be copied for the selected message."}} />
  <TempDir as="attachmentDirectory" />
  <Let as="privateAttachment" value={attachmentDirectory + "/attachment.json"} />
  <Let as="copyCommand" value={["install","-m","600",step.attachment,privateAttachment].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="attachmentCopy"
exec {copyCommand}
```
  <If condition={attachmentCopy.exitCode === 0}>
    <Let as="descriptorCommand" value={"cat -- '" + privateAttachment.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="descriptorRead"
exec {descriptorCommand}
```
    <Let as="report" value={{...report,diagnostic:"The copied attachment did not validate against the selected execution and conversation."}} />
    <If condition={descriptorRead.exitCode === 0}>
      <SafeParse schema={{type:"object",properties:{execution:{const:step.message.execution},conversation:{const:step.message.conversation}},required:["execution","conversation"]}} as="attachmentEvidence">{descriptorRead.stdout}</SafeParse>
      <If condition={attachmentEvidence.ok}>
        <Let as="entryArguments" value={[...step.xmd,"sidekick","read","--attach",privateAttachment,"entry",String(step.entry),"journal","--yq",'{"entry": .entry, "status": .status, "failure": .failure}']} />
        <Let as="entryCommand" value={entryArguments.map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="entryRead"
exec {entryCommand}
```
        <Let as="report" value={{...report,diagnostic:entryRead.exitCode === 0 ? "Entry read did not validate a complete result for the selected entry." : entryRead.stderr}} />
        <If condition={entryRead.exitCode === 0}>
          <SafeParse schema={{type:"object",properties:{value:{type:"object",properties:{entry:{const:step.entry},status:{enum:["completed","failed","cancelled","running","unfinished"]},failure:{type:["string","null"]}},required:["entry","status","failure"],additionalProperties:false},next:{type:"null"},prev:{type:"null"},last:{type:"null"}},required:["value","next","prev","last"],additionalProperties:false}} as="entryEvidence">{entryRead.stdout}</SafeParse>
          <If condition={entryEvidence.ok}>
            <Let as="page" value={entryEvidence.value.value} />
            <Let as="report" value={{entry:step.entry,status:page.status,exchangeOutcome:exchange.value.ending.outcome,joinedExchange:true,diagnostic:page.failure,read:{entry:step.entry,view:"journal"},resultStatus:"not-requested",result:null}} />
            <If condition={page.status === "completed" && !!step.resultFile}>
              <Let as="resultCommand" value={"cat -- '" + step.resultFile.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="resultRead"
exec {resultCommand}
```
              <Let as="report" value={{...report,status:"unavailable",entryStatus:page.status,resultStatus:"unavailable",diagnostic:resultRead.stderr}} />
              <If condition={resultRead.exitCode === 0}>
                <SafeParse schema={step.resultSchema ?? {type:"object"}} as="canonical">{resultRead.stdout}</SafeParse>
                <If condition={canonical.ok}>
                  <Let as="report" value={{...report,status:page.status,resultStatus:"readable",diagnostic:page.failure,result:canonical.value}} />
                <Else>
                  <Let as="report" value={{...report,resultStatus:"invalid",diagnostic:"The selected canonical result did not validate. Preserve its attempt and reconcile the original work.",validationErrors:canonical.errors}} />
                </Else>
                </If>
              </If>
            </If>
          </If>
        </If>
      </If>
    </If>
  </If>
</If>
<Return value={report} />
