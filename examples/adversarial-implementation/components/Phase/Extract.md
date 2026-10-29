---
props: {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": false}
returns: {type: object}
---

<Loop max={1}>
<Let as="replyText" value={props.text.trim()} />
<If condition={replyText.startsWith("{")}>
<Return value={{ok:true,json:replyText}} />
<Else>
<Let as="replyStart" value={replyText.indexOf("\n{")} />
<Let as="inlineRecords" value={Array.from(replyText.matchAll(new RegExp('\\{\\s*"schema"\\s*:\\s*"(?:phase-result\\.v2|pr-review-result\\.v1)"',"g")))} />
<Let as="inlineStart" value={inlineRecords.length === 1 ? inlineRecords[0].index : -1} />
<If condition={inlineRecords.length > 1 || replyStart < 0 && inlineStart < 0 || replyStart >= 0 && replyStart !== replyText.lastIndexOf("\n{")}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"extraction",message:"The provider reply does not contain one unambiguous final JSON record. Preserve the raw reply; do not infer a result from progress text.",issues:[]}}} /><Break />
</If>
<If condition={replyStart < 0 && replyText.includes("```")}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"extraction",message:"The provider reply is not JSON: the final record is fenced.",issues:[]}}} /><Break />
</If>
<Let as="replyJson" value={replyText.slice(replyStart < 0 ? inlineStart : replyStart + 1)} />
<Return value={{ok:true,json:replyJson}} />
</Else>
</If>

</Loop>
