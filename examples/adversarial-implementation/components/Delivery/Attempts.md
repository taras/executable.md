---
description: 'Read the retained review selection and attempts for one revision without prompting. Use <Delivery.Attempts delivery={delivery} revision={revision} as="attempts" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [delivery, revision]
  additionalProperties: false
returns: {type: object}
---

<Delivery.Selection delivery={props.delivery} revision={props.revision} as="selection" />
<Let as="directory" value={props.delivery.directory + "/review-" + props.revision} />
<Let as="quoted" value={"'" + directory.replaceAll("'","'\"'\"'") + "'"} />
<Let as="quotedReplacement" value={"'" + (directory + "/replacement").replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="occupied"
test -e {quoted} -o -L {quoted}
```
```bash exec as="replaced"
test -e {quotedReplacement} -o -L {quotedReplacement}
```
<If condition={occupied.exitCode !== 0}>
<Return value={{selection,directory,occupied:false,state:{selection:"absent",chain:selection.chain,attempts:[],candidate:null,effective:null,transition:null,next:"dispatch",hold:null}}} />
<Else>
<Delivery.ReviewState directory={directory} expected={selection} replacement={replaced.exitCode === 0} as="state" />
<Return value={{selection,directory,occupied:true,state}} />
</Else>
</If>
