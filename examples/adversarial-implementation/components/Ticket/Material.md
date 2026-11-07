---
description: 'Capture bounded preparation windows. Use <Ticket.Material inputs={inputs} directory={directory} as="material" />.'
props:
  type: object
  properties:
    inputs: {type: array, items: {type: object}}
    directory: {type: string, pattern: '^/'}
  required: [inputs, directory]
  additionalProperties: false
returns: {type: object}
---

Each window is retained as protected snapshot text under the directory and read
back before use. The returned documents name those snapshots for selection.

<Ticket.Windows inputs={props.inputs} as="windows" />
<Let as="inputs" value={[]} />
<Let as="documents" value={{}} />
<Let as="observations" value={[]} />
<Let as="index" value={0} />
<If condition={windows.length !== 0}>
<Loop max={windows.length}>
<Let as="window" value={windows[index]} />
<Let as="path" value={props.directory + "/" + String(index).padStart(4,"0") + ".txt"} />
<Ticket.Snapshot repository={props.directory} directory={props.directory} path={path} content={window.content} as="saved" />
<Ticket.Hydrate repository={props.directory} document={saved} as="text" />
<If condition={text.content !== window.content || text.content.length > 8000}><Fail message="Preparation window differs from its captured source." /></If>
<Ticket.Fingerprint inputs={[text]} as="hashes" />
<Let as="inputs" value={[...inputs,text]} />
<Let as="documents" value={{...documents,[path]:saved}} />
<Let as="observations" value={[...observations,{...hashes[0],source:window.source,start:window.start,end:window.end}]} />
<Let as="index" value={index+1} />
</Loop>
</If>
<Return value={{inputs,documents,observations,total:inputs.reduce((total,input) => total+input.content.length,0)}} />
