---
props: {"type": "object", "properties": {"result": {"type": "object"}, "successor": {"enum": ["discovery", "implementation", "review", "ready"]}, "role": {"anyOf": [{"enum": ["architect", "planner", "implementor"]}, {"type": "null"}], "default": null}}, "required": ["result", "successor"], "additionalProperties": false}
returns: {type: object}
---

<Loop max={1}>
<Let as="result" value={props.result} />
<Let as="target" value={result.outcome === "blocked" || result.outcome === "needs_decision" ? "hold" : result.outcome === "needs_discovery" ? "discovery" : result.outcome === "changes_required" || result.outcome === "missing_evidence" ? "implementation" : props.successor} />
<If condition={result.phase === "implementation" && result.outcome === "complete" && target !== "review" && !(target === "ready" && result.assessment?.mechanical === true)}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-11",message:"A completed implementation requires review of its exact feedback commit.",issues:[]}}} /><Break />
</If>
<If condition={result.phase === "discovery" && result.outcome === "complete" && target === "ready"}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-12",message:"Discovery requires an explicit next discovery, planning review or implementation gate.",issues:[]}}} /><Break />
</If>
<Let as="expectedRole" value={target === "implementation" ? "implementor" : result.outcome === "needs_discovery" ? result.apiConflict ? "planner" : "architect" : target === "hold" || target === "ready" ? null : props.role} />
<If condition={result.next.phase !== target || (expectedRole !== null && result.next.role !== expectedRole)}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-13",message:"The returned next role or phase differs from the selected gate. Preserve the reply and resolve the mismatch before dispatch.",issues:[]}}} /><Break />
</If>
<Return value={{ok:true,value:{phase:target === "hold" || target === "ready" ? target : "preparation",target:target === "hold" || target === "ready" ? null : target,role:result.next.role,work:result.work,revision:result.revision,request:result.handoff}}} />
</Loop>
