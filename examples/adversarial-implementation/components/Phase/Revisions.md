---
props:
  type: object
  properties:
    repository: {type: string, pattern: '^/'}
    value: {type: object}
  required: [repository, value]
  additionalProperties: false
returns: {type: object}
---

<Let as="value" value={props.value} />
<Let as="evidence" value={Array.isArray(value.evidence) ? value.evidence : []} />
<Let as="references" value={[...new Set([value.revision,...evidence.map(entry => entry?.revision)].filter(reference => typeof reference === "string" && /^[0-9a-f]{4,39}$/.test(reference)))]} />
<Let as="resolved" value={{}} />
<Let as="changes" value={[]} />
<Let as="rejection" value={null} />
<Let as="index" value={0} />
<Loop max={Math.max(1,references.length)}>
<If condition={index >= references.length}><Break /></If>
<Let as="reference" value={references[index]} />
<Dir path={props.repository}>
```bash exec as="objects"
git rev-parse --disambiguate={reference}
```
<Let as="matches" value={objects.stdout.trim().split(/\s+/).filter(Boolean)} />
<If condition={objects.exitCode !== 0 || matches.length !== 1 || !/^[0-9a-f]{40}$/.test(matches[0])}>
<Let as="rejection" value={{kind:"response_validation",code:"revision-identity",message:"The abbreviated revision " + reference + " does not identify one Git object in the assigned repository.",issues:[],terminal:true}} /><Break />
</If>
<Let as="revision" value={matches[0]} />
```bash exec as="kind"
git cat-file -t {revision}
```
<If condition={kind.exitCode !== 0 || kind.stdout.trim() !== "commit"}>
<Let as="rejection" value={{kind:"response_validation",code:"revision-identity",message:"The abbreviated revision " + reference + " does not identify a commit: " + (kind.stderr || kind.stdout),issues:[],terminal:true}} /><Break />
</If>
<Let as="resolved" value={{...resolved,[reference]:revision}} />
<Let as="changes" value={[...changes,{abbreviation:reference,revision}]} />
<Let as="index" value={index + 1} />
</Dir>
</Loop>
<If condition={rejection !== null}><Return value={{ok:false,rejection}} /><Else>
<Return value={{ok:true,value:{...value,revision:(Object.hasOwn(resolved,value.revision) ? resolved[value.revision] : value.revision),...(Array.isArray(value.evidence) ? {evidence:evidence.map(entry => entry && typeof entry === "object" ? {...entry,revision:(Object.hasOwn(resolved,entry.revision) ? resolved[entry.revision] : entry.revision)} : entry)} : {})},changes}} />
</Else></If>
