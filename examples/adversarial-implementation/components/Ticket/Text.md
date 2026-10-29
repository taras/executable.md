---
description: >-
  Record a text file once for this execution. Use <Ticket.Text
  path={artifactPath} as="text" />.
props:
  type: object
  properties:
    path: {type: string, minLength: 1}
  required: [path]
  additionalProperties: false
returns: {type: string}
---

The command's recorded output supplies the text on replay. A missing file fails
with the original command output instead of becoming an empty document.

<Let as="quotedPath" value={"'" + props.path.replaceAll("'", "'\"'\"'") + "'"} />
```bash exec as="captured"
cat -- {quotedPath}
```
<If condition={captured.exitCode !== 0}><Fail message={"Text capture failed: " + JSON.stringify(captured)} /></If>
<Return value={captured.stdout} />
