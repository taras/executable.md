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
<Ticket.Windows inputs={props.inputs} as="windows" />
<Let as="inputs" value={[]} />
<Let as="observations" value={[]} />
<Let as="index" value={0} />
<If condition={windows.length !== 0}>
<Loop max={windows.length}>
<Let as="window" value={windows[index]} />
<Let as="path" value={props.directory + "/" + String(index).padStart(4,"0") + ".txt"} />
<Dir path={props.directory}><File path={String(index).padStart(4,"0") + ".txt"}>{window.content}</File></Dir>
<Ticket.Text path={path} as="text" />
<If condition={text !== window.content || text.length > 8000}><Fail message="Preparation window differs from its captured source." /></If>
<Ticket.Fingerprint inputs={[{path,content:text}]} as="hashes" />
<Let as="inputs" value={[...inputs,{path,content:text}]} />
<Let as="observations" value={[...observations,{...hashes[0],source:window.source,start:window.start,end:window.end}]} />
<Let as="index" value={index+1} />
</Loop>
</If>
<Return value={{inputs,observations,total:inputs.reduce((total,input) => total+input.content.length,0)}} />
