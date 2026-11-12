---
description: 'Check one independent review without changing it. Use <Delivery.Validate text={raw} revision={revision} acceptance={clauses} as="checked" />.'
props:
  type: object
  properties:
    text: {type: string}
    revision: {type: string}
    acceptance: {type: array}
    frozen: {type: [object, 'null'], default: null}
  required: [text, revision, acceptance]
  additionalProperties: false
returns: {type: object}
---

<Delivery.Schema as="schemas" />
<Phase.Extract text={props.text} as="extracted" />
<If condition={!extracted.ok}>
<Return value={{ok:false,repairable:false,reason:extracted.rejection.message}} />
<Else>
<Let as="relaxed" value={{...schemas.review,properties:{...schemas.review.properties,summary:{...schemas.review.properties.summary,maxLength:undefined}}}} />
<SafeParse schema={relaxed} as="parsed">{extracted.json}</SafeParse>
<If condition={!parsed.ok}>
<Return value={{ok:false,repairable:false,reason:"The review has a defect beyond summary length."}} />
<Else>
<Let as="result" value={parsed.value} />
<Let as="frozen" value={props.frozen} />
<Let as="frozenSchema" value={frozen === null ? relaxed : {...relaxed,properties:Object.fromEntries(Object.entries(relaxed.properties).map(([key,value]) => [key,key === "summary" ? value : {const:frozen[key]}]))}} />
<SafeParse schema={frozenSchema} as="correspondence"><Json value={result} /></SafeParse>
<If condition={result.revision !== props.revision || result.acceptance.length !== props.acceptance.length || props.acceptance.some(clause => !result.acceptance.includes(clause.id)) || result.verdict === "pass" && result.findings.some(finding => finding.blocking) || !correspondence.ok}>
<Return value={{ok:false,repairable:false,reason:"The review changed its revision, clauses, verdict or frozen fields."}} />
<Else>
<Return value={{ok:result.summary.length <= schemas.review.properties.summary.maxLength,repairable:result.summary.length > schemas.review.properties.summary.maxLength,result,reason:result.summary.length > schemas.review.properties.summary.maxLength ? "The review summary exceeds its recorded limit." : null}} />
</Else>
</If>
</Else>
</If>
</Else>
</If>
